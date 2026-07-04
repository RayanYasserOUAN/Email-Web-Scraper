import uuid
import json
import csv
import io
import os
import time
import threading
import re
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from email_scraper import scrape_multiple

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=None)
CORS(app)

jobs = {}
job_queues = {}
job_lock = threading.Lock()


@app.route('/')
def index():
    for candidate in ['scraper_app/index.html', 'index.html']:
        path = os.path.join(BASE_DIR, candidate)
        if os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                return f.read(), 200, {'Content-Type': 'text/html; charset=utf-8'}
    return 'OK', 200


@app.route('/<path:filename>')
def serve_static(filename):
    allowed = {'styles.css', 'script.js'}
    if filename in allowed:
        path = os.path.join(BASE_DIR, 'scraper_app', filename)
        if os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                return f.read(), 200, {'Content-Type': 'text/css' if filename.endswith('.css') else 'application/javascript'}
    return 'Not Found', 404


@app.route('/preview-csv', methods=['POST'])
def preview_csv():
    file = request.files.get('csv_file')
    if not file:
        return jsonify({'error': 'No file uploaded'}), 400
    try:
        content = file.read().decode('utf-8-sig', errors='replace')
        reader = csv.reader(io.StringIO(content))
        rows = [row for row in reader if any(cell.strip() for cell in row)]
        if not rows:
            return jsonify({'error': 'CSV file is empty'}), 400
        headers = rows[0]
        preview = rows[1:6]
        url_col_index = None
        url_keywords = ['url', 'website', 'site', 'link', 'domain', 'web', 'href', 'address']
        for i, h in enumerate(headers):
            if any(kw in h.lower() for kw in url_keywords):
                url_col_index = i
                break
        if url_col_index is None and len(rows) > 1:
            for col_idx in range(len(headers)):
                for row in rows[1:6]:
                    if col_idx < len(row):
                        val = row[col_idx].strip()
                        if val.startswith(('http://', 'https://')) or '.' in val.split('/')[0]:
                            url_col_index = col_idx
                            break
                if url_col_index is not None:
                    break
        return jsonify({
            'headers': headers,
            'preview': preview,
            'suggested_column': url_col_index,
            'total_rows': len(rows) - 1,
        })
    except Exception as e:
        return jsonify({'error': f'Failed to parse CSV: {str(e)}'}), 400


@app.route('/scrape', methods=['POST'])
def start_scrape():
    max_workers = 5
    crawl_depth = 0
    urls = []

    # JSON mode (direct URL list from textarea)
    if request.is_json:
        body = request.get_json(silent=True)
        if not body or not body.get('urls'):
            return jsonify({'error': 'No URLs provided'}), 400
        urls = body.get('urls', [])
        max_workers = body.get('max_workers', 5)
        crawl_depth = body.get('crawl_depth', 0)
        timeout = body.get('timeout', 10)

    # CSV mode (file upload)
    else:
        file = request.files.get('csv_file')
        col_index = request.form.get('col_index', type=int)
        max_workers = request.form.get('max_workers', 5, type=int)
        crawl_depth = request.form.get('crawl_depth', 0, type=int)

        if not file:
            return jsonify({'error': 'No CSV file uploaded'}), 400
        if col_index is None:
            return jsonify({'error': 'No column selected'}), 400

        try:
            content = file.read().decode('utf-8-sig', errors='replace')
            rows = list(csv.reader(io.StringIO(content)))
        except Exception as e:
            return jsonify({'error': f'Failed to read CSV: {str(e)}'}), 400

        if not rows:
            return jsonify({'error': 'CSV is empty'}), 400

        for row in rows[1:]:
            if col_index < len(row):
                val = row[col_index].strip()
                if val:
                    if not val.startswith(('http://', 'https://')):
                        val = 'https://' + val
                    if val not in urls:
                        urls.append(val)

    if not urls:
        return jsonify({'error': 'No URLs found'}), 400

    if max_workers is None: max_workers = 5
    if crawl_depth is None: crawl_depth = 0
    max_workers = max(1, min(max_workers, 200))
    crawl_depth = max(0, min(crawl_depth, 3))

    job_id = str(uuid.uuid4())
    with job_lock:
        jobs[job_id] = {
            'status': 'running',
            'total': len(urls),
            'current': 0,
            'email_count': 0,
            'phone_count': 0,
            'results': {},
            'all_emails': [],
            'all_phones': [],
            'max_workers': max_workers,
            'crawl_depth': crawl_depth,
            'total_pages_scraped': 0,
        }
        job_queues[job_id] = []

    thread = threading.Thread(
        target=run_scrape,
        args=(job_id, urls, max_workers, crawl_depth),
        daemon=True,
    )
    thread.start()

    return jsonify({'job_id': job_id, 'total': len(urls)})


def run_scrape(job_id, urls, max_workers, crawl_depth):
    total = len(urls)

    def on_progress(url, emails, phones, pages, error):
        with job_lock:
            j = jobs[job_id]
            j['current'] += 1
            cur_emails = set(j.get('all_emails', []))
            cur_phones = set(j.get('all_phones', []))
            cur_emails.update(emails)
            cur_phones.update(phones)
            j['all_emails'] = list(cur_emails)
            j['all_phones'] = list(cur_phones)
            j['email_count'] = len(cur_emails)
            j['phone_count'] = len(cur_phones)
            j['total_pages_scraped'] += pages
            j['results'][url] = {
                'emails': list(emails),
                'phones': list(phones),
                'pages_scraped': pages,
            }

        log_entry = {
            'url': url,
            'status': 'error' if error else 'done',
            'count': len(emails),
            'phone_count': len(phones),
            'pages_scraped': pages,
            'emails': list(emails),
            'phones': list(phones),
        }
        if error:
            log_entry['error'] = error

        _push(job_id, {
            'type': 'progress',
            'current': j['current'],
            'total': total,
            'email_count': j['email_count'],
            'phone_count': j['phone_count'],
            'total_pages_scraped': j['total_pages_scraped'],
            'log': [log_entry],
        })

    data = scrape_multiple(urls, max_workers=max_workers, max_depth=crawl_depth, progress_callback=on_progress)

    with job_lock:
        j = jobs[job_id]
        j['status'] = 'done'
        j['all_emails'] = data['all_emails']
        j['all_phones'] = data['all_phones']
        j['total_pages_scraped'] = data['total_pages_scraped']

    _push(job_id, {
        'type': 'done',
        'total': total,
        'total_pages_scraped': data['total_pages_scraped'],
        'all_emails': data['all_emails'],
        'all_phones': data['all_phones'],
        'results': data['results'],
    })


def _push(job_id, event):
    with job_lock:
        if job_id in job_queues:
            job_queues[job_id].append(event)


@app.route('/stream/<job_id>')
def stream(job_id):
    def generate():
        sent = 0
        while True:
            with job_lock:
                queue = list(job_queues.get(job_id, []))
            while sent < len(queue):
                event = queue[sent]
                yield f'data: {json.dumps(event)}\n\n'
                sent += 1
                if event.get('type') == 'done':
                    return
            with job_lock:
                status = jobs.get(job_id, {}).get('status')
            if status == 'done' and sent >= len(queue):
                return
            time.sleep(0.25)

    return Response(
        generate(),
        content_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        },
    )


@app.route('/jobs')
def list_jobs():
    with job_lock:
        job_list = [
            {
                'job_id': jid,
                'status': d['status'],
                'total': d['total'],
                'email_count': d['email_count'],
                'phone_count': d.get('phone_count', 0),
                'crawl_depth': d.get('crawl_depth', 0),
                'total_pages_scraped': d.get('total_pages_scraped', 0),
            }
            for jid, d in jobs.items()
        ]
    return jsonify(job_list)


@app.route('/download/<job_id>/<export_type>')
def download(job_id, export_type):
    with job_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404

    output = io.StringIO()
    writer = csv.writer(output)

    if export_type == 'summary':
        writer.writerow(['Email', 'Source URL', 'Phones'])
        for url, res in job.get('results', {}).items():
            emails = res.get('emails', [])
            phones = res.get('phones', [])
            for email in sorted(emails):
                writer.writerow([email, url, '; '.join(phones)])
        filename = f'emails_with_source_{job_id[:8]}.csv'
    elif export_type == 'unique':
        writer.writerow(['Email'])
        for email in sorted(set(job.get('all_emails', []))):
            writer.writerow([email])
        filename = f'unique_emails_{job_id[:8]}.csv'
    elif export_type == 'phones':
        writer.writerow(['Phone', 'Source URL'])
        for url, res in job.get('results', {}).items():
            for phone in sorted(set(res.get('phones', []))):
                writer.writerow([phone, url])
        filename = f'phones_{job_id[:8]}.csv'
    else:
        return jsonify({'error': 'Invalid export type'}), 400

    output.seek(0)
    return Response(
        output.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@app.route('/download/<job_id>/json')
def download_json(job_id):
    with job_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404

    data = {
        'job_id': job_id,
        'total_urls': job.get('total'),
        'total_pages_scraped': job.get('total_pages_scraped', 0),
        'all_emails': sorted(set(job.get('all_emails', []))),
        'all_phones': sorted(set(job.get('all_phones', []))),
        'results': job.get('results', {}),
        'crawl_depth': job.get('crawl_depth', 0),
        'max_workers': job.get('max_workers', 5),
    }
    return Response(
        json.dumps(data, indent=2),
        mimetype='application/json',
        headers={
            'Content-Disposition': f'attachment; filename="results_{job_id[:8]}.json"'
        },
    )


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print('=' * 60)
    print('  LeadScraper \u2014 Web UI (Enhanced)')
    print(f'  Open: http://0.0.0.0:{port}')
    print('=' * 60)
    app.run(host='0.0.0.0', port=port, threaded=True, use_reloader=False)
