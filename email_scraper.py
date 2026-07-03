import requests
from bs4 import BeautifulSoup
import re
import csv
from urllib.parse import urlparse, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import random

# ── Defaults ───────────────────────────────────────────────────────────────────
DEFAULT_TIMEOUT = 10
MAX_RETRIES = 2
BACKOFF_BASE = 1.0
USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
]
_session = requests.Session()
EMAIL_PATTERN = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')
PHONE_PATTERN = re.compile(r'(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}')
NON_EMAIL_DOMAINS = {
    'example.com', 'example.net', 'example.org', 'domain.com',
    'yourdomain.com', 'email.com', 'mail.com', 'test.com',
}


def _headers():
    return {'User-Agent': random.choice(USER_AGENTS)}


def _fetch(url, timeout=DEFAULT_TIMEOUT):
    """Fetch a URL with retry logic and exponential backoff."""
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = _session.get(url, timeout=timeout, headers=_headers())
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            last_err = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(BACKOFF_BASE * (2 ** attempt) + random.random())
    raise last_err


def _clean_email(email):
    """Validate and normalize a candidate email address."""
    email = email.lower().strip()
    if '@' not in email or '.' not in email.split('@')[1]:
        return None
    # Filter file extensions
    if email.endswith(('.png', '.jpg', '.jpeg', '.gif', '.css', '.js', '.svg', '.ico', '.webp')):
        return None
    domain = email.split('@')[1]
    if domain in NON_EMAIL_DOMAINS:
        return None
    return email


def _extract_emails(soup, raw_html):
    """Extract emails from mailto links + regex on text and raw HTML."""
    emails = set()
    for a in soup.find_all('a', href=True):
        href = a['href']
        if href.startswith('mailto:'):
            e = href.replace('mailto:', '').split('?')[0].lower().strip()
            if '@' in e:
                emails.add(e)
    for src in [soup.get_text(), raw_html]:
        for m in EMAIL_PATTERN.findall(src):
            cleaned = _clean_email(m)
            if cleaned:
                emails.add(cleaned)
    return emails


def _extract_phones(soup):
    """Extract phone numbers from page text."""
    phones = set()
    for m in PHONE_PATTERN.findall(soup.get_text()):
        digits = re.sub(r'\D', '', m)
        if 7 <= len(digits) <= 15:
            phones.add(m.strip())
    return phones


def _same_domain_links(soup, base_url, domain):
    """Get all same-domain HTTP(S) links from a page."""
    links = set()
    for a in soup.find_all('a', href=True):
        href = a['href'].strip()
        if not href or href.startswith(('#', 'javascript:', 'mailto:', 'tel:')):
            continue
        abs_url = urljoin(base_url, href)
        p = urlparse(abs_url)
        if p.netloc == domain and p.scheme in ('http', 'https'):
            clean = f"{p.scheme}://{p.netloc}{p.path}"
            if p.query:
                clean += f"?{p.query}"
            links.add(clean)
    return links


def _scrape_page(url, timeout=DEFAULT_TIMEOUT):
    """Scrape a single page and return (emails, phones, same_domain_links) or None."""
    try:
        resp = _fetch(url, timeout=timeout)
        soup = BeautifulSoup(resp.text, 'html.parser')
        parsed = urlparse(url)
        domain = parsed.netloc
        for el in soup(['script', 'style']):
            el.decompose()
        emails = _extract_emails(soup, resp.text)
        phones = _extract_phones(soup)
        links = _same_domain_links(soup, url, domain) if (emails or phones) else set()
        return (emails, phones, links)
    except Exception:
        return None


# ── Public API ─────────────────────────────────────────────────────────────────

def scrape_emails_from_url(url, timeout=DEFAULT_TIMEOUT):
    """Scrape emails from a single URL. Returns a set of emails."""
    try:
        resp = _fetch(url, timeout=timeout)
        soup = BeautifulSoup(resp.text, 'html.parser')
        for el in soup(['script', 'style']):
            el.decompose()
        return _extract_emails(soup, resp.text)
    except Exception:
        return set()


def scrape_url_deep(url, max_depth=0, timeout=DEFAULT_TIMEOUT):
    """
    Scrape emails + phones from a URL, optionally crawling same-domain links up to max_depth.
    Returns dict with:
      - 'emails': set of unique emails
      - 'phones': set of unique phones
      - 'pages_scraped': int
    """
    parsed = urlparse(url)
    domain = parsed.netloc
    all_emails = set()
    all_phones = set()
    visited = set()
    to_visit = {url}
    pages_scraped = 0

    for depth in range(max_depth + 1):
        if not to_visit:
            break
        batch = list(to_visit - visited)
        to_visit = set()

        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = {pool.submit(_scrape_page, u, timeout): u for u in batch}
            for f in as_completed(futures):
                u = futures[f]
                visited.add(u)
                try:
                    res = f.result()
                    if res is None:
                        continue
                    emails, phones, links = res
                    pages_scraped += 1
                    all_emails.update(emails)
                    all_phones.update(phones)
                    if depth < max_depth:
                        to_visit.update(links - visited)
                except Exception:
                    pass

    return {
        'emails': all_emails,
        'phones': all_phones,
        'pages_scraped': pages_scraped,
    }


def scrape_multiple(urls, max_workers=5, max_depth=0, timeout=DEFAULT_TIMEOUT, progress_callback=None):
    """
    Scrape multiple URLs concurrently with ThreadPoolExecutor.

    When max_depth > 0, each URL is deep-crawled (same-domain links up to that depth).
    Returns dict with:
      - 'results': { url: { 'emails': [...], 'phones': [...], 'pages_scraped': int } }
      - 'all_emails': sorted list of unique emails across all URLs
      - 'all_phones': sorted list of unique phones across all URLs
      - 'total_pages_scraped': int
    """
    results = {}
    all_emails = set()
    all_phones = set()
    total_pages = 0

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {}
        for u in urls:
            if max_depth > 0:
                futures[pool.submit(scrape_url_deep, u, max_depth, timeout)] = u
            else:
                futures[pool.submit(scrape_emails_from_url, u, timeout)] = u

        for f in as_completed(futures):
            u = futures[f]
            try:
                data = f.result()
                if max_depth > 0:
                    emails, phones, pages = data['emails'], data['phones'], data['pages_scraped']
                else:
                    emails, phones, pages = data, set(), 1
                results[u] = {
                    'emails': list(emails),
                    'phones': list(phones),
                    'pages_scraped': pages,
                }
                all_emails.update(emails)
                all_phones.update(phones)
                total_pages += pages
                if progress_callback:
                    progress_callback(u, emails, phones, pages, None)
            except Exception as e:
                results[u] = {'emails': [], 'phones': [], 'pages_scraped': 0}
                if progress_callback:
                    progress_callback(u, set(), set(), 0, str(e))

    return {
        'results': results,
        'all_emails': sorted(all_emails),
        'all_phones': sorted(all_phones),
        'total_pages_scraped': total_pages,
    }


# ── CLI (backward-compatible) ──────────────────────────────────────────────────

def scrape_multiple_urls(urls, output_file='scraped_emails.csv'):
    """Legacy CLI wrapper for the original API."""
    data = scrape_multiple(urls, max_workers=1, max_depth=0)
    all_emails = set(data['all_emails'])
    results_map = {u: set(v['emails']) for u, v in data['results'].items()}

    print(f"Starting to scrape {len(urls)} URLs...\n")
    for url in urls:
        site_emails = results_map.get(url, set())
        print(f"Scraping: {url}")
        if site_emails:
            print(f"  \u2713 Found {len(site_emails)} email(s)")
        else:
            print(f"  \u2717 No emails found")

    with open(output_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Email', 'Source URL'])
        for url, emails in results_map.items():
            for email in sorted(emails):
                writer.writerow([email, url])

    unique_file = 'unique_' + output_file
    with open(unique_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Email'])
        for email in sorted(all_emails):
            writer.writerow([email])

    print(f"\n{'='*50}")
    print(f"Scraping Complete!")
    print(f"Total URLs scraped: {len(urls)}")
    print(f"URLs with emails: {sum(1 for e in results_map.values() if e)}")
    print(f"Total unique emails: {len(all_emails)}")
    print(f"\nResults saved to:")
    print(f"  \u2022 {output_file} (with source URLs)")
    print(f"  \u2022 {unique_file} (unique emails only)")
    return all_emails


if __name__ == "__main__":
    print("=" * 60)
    print("EMAIL SCRAPER - Enter URLs to scrape for email addresses")
    print("=" * 60)

    print("\nChoose an option:")
    print("1. Enter URLs interactively (one at a time)")
    print("2. Use example URLs (demo mode)")

    choice = input("\nEnter your choice (1 or 2): ").strip()
    urls_to_scrape = []

    if choice == "1":
        print("\nEnter URLs to scrape (type 'done' when finished):")
        while True:
            url_input = input("Enter URL (or 'done' to finish): ").strip()
            if url_input.lower() == 'done':
                break
            if url_input:
                if not url_input.startswith(('http://', 'https://')):
                    url_input = 'https://' + url_input
                urls_to_scrape.append(url_input)
                print(f"  \u2713 Added: {url_input}")
        if urls_to_scrape:
            print(f"\nYou entered {len(urls_to_scrape)} URL(s). Starting scrape...\n")
            scrape_multiple_urls(urls_to_scrape)
        else:
            print("\nNo URLs entered. Exiting.")
    elif choice == "2":
        urls_to_scrape = [
            "https://example.com/contact",
            "https://example.com/about",
            "https://example.com/team",
        ]
        scrape_multiple_urls(urls_to_scrape)
    else:
        print("Invalid choice. Exiting.")
