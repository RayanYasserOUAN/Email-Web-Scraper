// ═══ STATE ═══
let currentJobId   = null;
let selectedColIdx = null;
let csvFile        = null;
let csvHeaders     = [];
let eventSource    = null;
let sessionJobs    = 0;
let sessionEmails  = 0;
let sessionPhones  = 0;
let completedData  = {};
let crawlDepth = 0;
let maxWorkers = 5;
let errorCount = 0;
let mProcessed = 0;
let mSuccess = 0;
let jobStartTime = null;
let jobTimerInterval = null;
let logLineCount = 0;
const API = 'https://lead-scraper-api-kqr.onrender.com';

// ═══ NAVIGATION ═══
const SCREEN_TITLES = { dashboard:'[1] DASHBOARD', active:'[2] ACTIVE_JOBS', config:'[3] CONFIG_ENV', results:'[4] SCRAPE_DB' };

function switchScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('screen-' + name);
  if (target) target.classList.add('active');
  const isResults = name === 'results';
  document.getElementById('results-footer').style.display = isResults ? 'flex' : 'none';
  document.getElementById('page-title').textContent = SCREEN_TITLES[name] || name;
  document.getElementById('main-content').classList.remove('pb-6');
  if (isResults) document.getElementById('main-content').classList.add('pb-6');
  document.querySelectorAll('.nav-link').forEach(l => {
    const act = l.dataset.screen === name;
    l.classList.toggle('bg-primary-container', act);
    l.classList.toggle('text-on-primary-container', act);
    l.classList.toggle('font-bold', act);
    l.classList.toggle('border-l-4', act);
    l.classList.toggle('border-primary', act);
    l.classList.toggle('text-on-surface-variant', !act);
    l.classList.toggle('hover:bg-surface-variant', !act);
  });
  if (name === 'results') populateResultsPage();
  if (name === 'dashboard') refreshJobs();
}

document.querySelectorAll('.nav-link').forEach(btn => {
  btn.addEventListener('click', (e) => { e.preventDefault(); switchScreen(btn.dataset.screen); });
});

// ═══ SETTINGS ═══
function updateSettings() {
  crawlDepth = parseInt(document.getElementById('crawl-depth2').value);
  maxWorkers = parseInt(document.getElementById('max-workers2').value);
  document.getElementById('depth-val').textContent = crawlDepth;
  document.getElementById('workers-val').textContent = maxWorkers;
  document.getElementById('depth-val2').textContent = crawlDepth;
  document.getElementById('workers-val2').textContent = maxWorkers;
}

// ═══ CSV UPLOAD ═══
const dropZone = document.getElementById('drop-zone');
const csvInput = document.getElementById('csv-input');
csvInput.addEventListener('change', () => { if (csvInput.files[0]) handleFile(csvInput.files[0]); });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = '#00ff00'; });
dropZone.addEventListener('dragleave', () => dropZone.style.borderColor = '');
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.style.borderColor = ''; if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

function clearFile() {
  csvFile = null; selectedColIdx = null; csvHeaders = [];
  document.getElementById('csv-input').value = '';
  document.getElementById('file-label').textContent = 'SUPPORTED: .CSV (MAX 50MB)';
  document.getElementById('col-section').style.display = 'none';
  document.getElementById('start-btn').disabled = true;
  document.getElementById('start-btn').innerHTML = '<span class="material-symbols-outlined text-[18px]">play_arrow</span> INITIALIZE_SCRAPE';
}

function updateSystemBars(cur, total, emails, phones) {
  const pct = total > 0 ? Math.min(Math.round((cur/total)*100), 100) : 0;
  const ebar = Math.min(Math.round(emails/20), 20);
  const tbar = Math.min(Math.round(pct/5), 20);
  document.getElementById('sys-threads').textContent = `${cur}/${total}`;
  document.getElementById('sys-threads-bar').textContent = `[${'█'.repeat(tbar)}${'░'.repeat(20-tbar)}] ${pct}%`;
  document.getElementById('sys-emails').textContent = emails.toLocaleString();
  document.getElementById('sys-emails-bar').textContent = `[${'█'.repeat(ebar)}${'░'.repeat(20-ebar)}] ${emails}`;
  const errRate = total > 0 ? Math.round((errorCount/total)*100) : 0;
  document.getElementById('stat-err-rate').textContent = errRate + '%';
  document.getElementById('stat-total-found').textContent = (emails+phones).toLocaleString();
}

async function handleFile(file) {
  if (!file.name.match(/\.(csv|txt)$/i)) { showToast('REQUIRE .CSV OR .TXT', 'error'); return; }
  csvFile = file;
  document.getElementById('file-label').textContent = '✓ SELECTED: ' + file.name + ' (' + formatBytes(file.size) + ')';
  const fd = new FormData();
  fd.append('csv_file', file);
  try {
    const res = await fetch(API + '/preview-csv', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); return; }
    csvHeaders = data.headers;
    buildColumnPicker(data.headers, data.preview, data.suggested_column, data.total_rows);
    document.getElementById('col-section').style.display = 'block';
    if (data.suggested_column !== null) selectColumn(data.suggested_column, data.headers[data.suggested_column]);
  } catch (err) { showToast('PARSE_FAIL: ' + err.message, 'error'); }
}

function buildColumnPicker(headers, preview, suggested, totalRows) {
  document.getElementById('row-count').textContent = totalRows + ' DATA_ROWS';
  const cards = document.getElementById('col-cards'); cards.innerHTML = '';
  headers.forEach((h, i) => {
    const card = document.createElement('div');
    card.className = 'col-card border px-3 py-2 relative text-[12px] font-mono';
    card.dataset.idx = i;
    card.innerHTML = '<div class="font-bold text-primary">' + escHtml(h) + '</div><div class="text-[10px] text-on-surface-variant">col ' + (i+1) + '</div>';
    if (i === suggested) { card.classList.add('selected'); }
    card.addEventListener('click', () => selectColumn(i, h));
    cards.appendChild(card);
  });
  const thead = document.getElementById('preview-thead'); thead.innerHTML = '';
  const tbody = document.getElementById('preview-tbody'); tbody.innerHTML = '';
  headers.forEach(h => {
    const th = document.createElement('th');
    th.className = 'px-3 py-2 font-mono text-[10px] text-on-surface-variant uppercase border-b border-outline whitespace-nowrap';
    th.textContent = h; thead.appendChild(th);
  });
  preview.forEach(row => {
    const tr = document.createElement('tr'); tr.className = 'hover:bg-surface-container-high/40 transition-colors';
    headers.forEach((_, ci) => {
      const td = document.createElement('td');
      td.className = 'px-3 py-1.5 text-[11px] text-on-surface/80 truncate max-w-[180px]';
      td.textContent = row[ci] ?? ''; tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function selectColumn(idx, name) {
  selectedColIdx = idx;
  document.querySelectorAll('.col-card').forEach(c => {
    c.style.borderColor = parseInt(c.dataset.idx) === idx ? '#00ff00' : '#3b4b35';
  });
  document.querySelectorAll('#preview-table th, #preview-table td').forEach((el, i) => {
    if (el.tagName === 'TH') { el.style.color = i === idx ? '#00ff00' : ''; return; }
    el.style.color = (i % csvHeaders.length) === idx ? '#00ff00' : '';
  });
  document.getElementById('col-hint').textContent = 'Column "' + name + '" selected';
  document.getElementById('start-btn').disabled = false;
}

// ═══ INIT SCRAPE (textarea) ═══
async function initScrapeFromTextarea() {
  const text = document.getElementById('url-textarea').value.trim();
  if (!text) { showToast('NO_URLS_IN_BUFFER', 'error'); return; }
  const urls = text.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  if (urls.length === 0) { showToast('NO_VALID_URLS', 'error'); return; }
  const btn = document.getElementById('init-scrape-btn');
  btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">sync</span> INITIALIZING...';
  await startScrape(urls, btn);
}

// ═══ INIT SCRAPE (CSV) ═══
async function startScrapeFromCSV() {
  if (!csvFile || selectedColIdx === null) return;
  const btn = document.getElementById('start-btn');
  btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">sync</span> INITIALIZING...';
  const fd = new FormData();
  fd.append('csv_file', csvFile);
  fd.append('col_index', selectedColIdx);
  fd.append('max_workers', maxWorkers);
  fd.append('crawl_depth', crawlDepth);
  fd.append('timeout', parseInt(document.getElementById('timeout-range')?.value || 10));
  try {
    const res = await fetch(API + '/scrape', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined text-[18px]">play_arrow</span> INITIALIZE_SCRAPE'; return; }
    onScrapeStarted(data);
  } catch (err) { showToast('FAIL: ' + err.message, 'error'); btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined text-[18px]">play_arrow</span> INITIALIZE_SCRAPE'; }
}

async function startScrape(urls, btn) {
  try {
    const res = await fetch(API + '/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: urls, max_workers: maxWorkers, crawl_depth: crawlDepth, timeout: parseInt(document.getElementById('timeout-range')?.value || 10) })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined text-[18px]">play_arrow</span> INITIALIZE_SCRAPE'; return; }
    onScrapeStarted(data);
  } catch (err) { showToast('FAIL: ' + err.message, 'error'); btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined text-[18px]">play_arrow</span> INITIALIZE_SCRAPE'; }
}

function onScrapeStarted(data) {
  currentJobId = data.job_id;
  resetMonitor(data.total);
  sessionJobs++;
  document.getElementById('stat-jobs').textContent = sessionJobs;
  connectSSE(currentJobId);
  switchScreen('active');
}

// ═══ MONITOR ═══
function resetMonitor(total) {
  errorCount = mProcessed = mSuccess = logLineCount = 0;
  jobStartTime = Date.now();
  if (jobTimerInterval) clearInterval(jobTimerInterval);
  jobTimerInterval = setInterval(updateUptime, 1000);
  document.getElementById('live-progress').textContent = '0%';
  document.getElementById('live-email-count').textContent = '0';
  document.getElementById('live-phones').textContent = '0';
  document.getElementById('live-processed').textContent = '0';
  document.getElementById('live-errors').textContent = '0';
  document.getElementById('email-progress-bar').style.width = '0%';
  document.getElementById('dist-emails').textContent = '0';
  document.getElementById('dist-phones').textContent = '0';
  document.getElementById('dist-pages').textContent = '0';
  document.getElementById('dist-success').textContent = '0';
  document.getElementById('job-title-banner').textContent = 'TASK_PROG: [' + '░'.repeat(20) + '] 0%';
  document.getElementById('job-url-banner').textContent = 'TARGET_URLS: ' + total;
  document.getElementById('banner-threads').textContent = '0 / ' + maxWorkers;
  document.getElementById('log-status-label').textContent = 'STATUS: RUNNING';
  document.getElementById('traffic-status').textContent = 'DATA_TRAFFIC: ACTIVE';
  document.getElementById('footer-job-id').textContent = currentJobId ? currentJobId.substring(0,8) : '—';
  updateSystemBars(0, total, 0, 0);
  document.getElementById('log-box').innerHTML = '<div class="text-on-surface-variant">[<span class="text-primary-fixed">*</span>] TASK_INITIALIZED: ' + total + ' URLS</div><div class="flex items-center gap-1 mt-2"><span class="text-primary-fixed">SCRAPER@LOCAL:~$</span><span class="w-2 h-4 bg-primary-fixed cursor-blink"></span></div>';
  document.getElementById('log-line-count').textContent = 'LINES: 0';
}

function updateUptime() {
  if (!jobStartTime) return;
  const e = Math.floor((Date.now()-jobStartTime)/1000);
  const h = String(Math.floor(e/3600)).padStart(2,'0');
  const m = String(Math.floor((e%3600)/60)).padStart(2,'0');
  const s = String(e%60).padStart(2,'0');
  document.getElementById('banner-uptime').textContent = h+':'+m+':'+s;
}

// ═══ SSE ═══
function connectSSE(jobId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(API + '/stream/' + jobId);
  eventSource.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'progress') onProgress(data);
      else if (data.type === 'done') onDone(data);
    } catch(ex) {}
  };
  eventSource.onerror = () => { if (eventSource) { eventSource.close(); eventSource = null; } };
}

function onProgress(data) {
  const cur = data.current || 0;
  const total = data.total || 1;
  const pct = Math.min(Math.round((cur/total)*100), 100);
  const emails = data.email_count || 0;
  const phones = data.phone_count || 0;
  mProcessed = cur;
  const filled = Math.round(pct/5);
  document.getElementById('job-title-banner').textContent = 'TASK_PROG: [' + '█'.repeat(filled) + '░'.repeat(20-filled) + '] ' + pct + '%';
  document.getElementById('live-progress').textContent = pct + '%';
  document.getElementById('email-progress-bar').style.width = Math.min(emails/100*100, 100) + '%';
  document.getElementById('live-email-count').textContent = emails.toLocaleString();
  document.getElementById('live-phones').textContent = phones.toLocaleString();
  document.getElementById('live-processed').textContent = cur;
  document.getElementById('banner-threads').textContent = Math.min(cur, maxWorkers) + ' / ' + maxWorkers;
  document.getElementById('dist-emails').textContent = emails.toLocaleString();
  document.getElementById('dist-phones').textContent = phones.toLocaleString();
  document.getElementById('dist-success').textContent = mSuccess;
  updateSystemBars(cur, total, emails, phones);
  for (const entry of (data.log || [])) {
    const t = new Date().toLocaleTimeString('en-GB',{hour12:false});
    if (entry.status === 'done') {
      const pc = entry.phone_count||0; const ec = entry.count||0;
      let label = 'OK';
      let msg = entry.url + '  (' + ec + ' email' + (ec!==1?'s':'');
      if (pc) msg += ', ' + pc + ' phone' + (pc!==1?'s':'');
      msg += ')';
      if (ec > 0 || pc > 0) { addLog(t, label, msg, 'primary-fixed'); mSuccess++; }
      else addLog(t, '--', entry.url + '  (no data)', 'on-surface-variant');
    } else if (entry.status === 'error') {
      addLog(t, 'ERR', entry.url + '  ' + (entry.error||''), 'error');
      errorCount++; document.getElementById('live-errors').textContent = errorCount;
    }
  }
}

function onDone(data) {
  if (jobTimerInterval) { clearInterval(jobTimerInterval); jobTimerInterval = null; }
  const emails = data.all_emails || [];
  const phones = data.all_phones || [];
  completedData[currentJobId] = { all_emails:emails, all_phones:phones, results:data.results||{}, total:data.total };
  sessionEmails += emails.length;
  sessionPhones += phones.length;
  document.getElementById('stat-phones').textContent = sessionPhones.toLocaleString();
  document.getElementById('job-title-banner').textContent = 'TASK_PROG: [' + '█'.repeat(20) + '] 100%';
  document.getElementById('live-progress').textContent = '100%';
  document.getElementById('log-status-label').textContent = 'STATUS: COMPLETE';
  document.getElementById('traffic-status').textContent = 'DATA_TRAFFIC: COMPLETE';
  document.getElementById('banner-threads').textContent = '0 / 0';
  document.getElementById('footer-job-id').textContent = '—';
  updateSystemBars(data.total, data.total, emails.length, phones.length);
  const t = new Date().toLocaleTimeString('en-GB',{hour12:false});
  addLog(t, 'DONE', data.total + ' URLs — ' + emails.length + ' unique emails, ' + phones.length + ' phones', 'secondary-fixed-dim');
  if (eventSource) { eventSource.close(); eventSource = null; }
  showToast('COMPLETE: ' + emails.length + ' emails, ' + phones.length + ' phones', 'info');
}

function addLog(t, level, message, colorClass) {
  const box = document.getElementById('log-box');
  const div = document.createElement('div');
  div.className = 'fade-in text-on-surface-variant';
  div.innerHTML = '[' + t + '] <span class="text-' + colorClass + '">' + level + ':</span> ' + message;
  const cursor = box.lastElementChild;
  if (cursor && cursor.innerHTML.includes('SCRAPER@LOCAL')) box.insertBefore(div, cursor);
  else box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  logLineCount++; document.getElementById('log-line-count').textContent = 'LINES: ' + logLineCount;
}

function defaultLogHtml() {
  logLineCount = 0;
  document.getElementById('log-line-count').textContent = 'LINES: 0';
  return '<div class="text-on-surface-variant">[<span class="text-primary-fixed">*</span>] SCRAPER_OS_V1.0 INITIALIZED</div><div class="text-on-surface-variant">[<span class="text-primary-fixed">*</span>] AWAITING TASK_ASSIGNMENT...</div><div class="flex items-center gap-1 mt-2"><span class="text-primary-fixed">SCRAPER@LOCAL:~$</span><span class="w-2 h-4 bg-primary-fixed cursor-blink"></span></div>';
}

// ═══ TERMINATE ═══
function terminateJob() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  const t = new Date().toLocaleTimeString('en-GB',{hour12:false});
  addLog(t, 'KILL', 'TASK_TERMINATED_BY_OPERATOR', 'error');
  document.getElementById('log-status-label').textContent = 'STATUS: TERMINATED';
  document.getElementById('traffic-status').textContent = 'DATA_TRAFFIC: STOPPED';
  document.getElementById('banner-threads').textContent = '0 / 0';
  if (jobTimerInterval) { clearInterval(jobTimerInterval); jobTimerInterval = null; }
}

// ═══ RESULTS PAGE ═══
function populateResultsPage() {
  const jobId = currentJobId;
  const data = completedData[jobId];
  const tbody = document.getElementById('db-tbody');
  const preview = document.getElementById('preview-box');
  if (!data || !data.results) {
    tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-on-surface-variant/50">[ NO_COMPLETED_JOBS ]</td></tr>';
    preview.innerHTML = '<div class="mb-2 text-outline opacity-50 font-bold">// RAW_TEXT_OUTPUT [WAITING]</div><div class="text-on-surface-variant italic">[ NO_RESULTS_YET ]</div>';
    document.getElementById('db-total-records').textContent = 'TOTAL_RECORDS: 0';
    return;
  }
  let html = '', totalRecords = 0, idx = 0;
  const items = Object.entries(data.results);
  const now = new Date();
  const ts = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0')+'T'+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')+':'+String(now.getSeconds()).padStart(2,'0');
  items.forEach(([url,res]) => {
    let domain = '';
    try { domain = new URL(url).hostname; } catch(e) { domain = url; }
    const ec = (res.emails||[]).length;
    const pc = (res.phones||[]).length;
    totalRecords += ec + pc;
    const bg = idx % 2 === 0 ? '' : ' bg-surface-container-low';
    const status = (ec>0||pc>0) ? '<span class="bg-on-primary-container text-primary-fixed px-2 border border-primary-fixed">SUCCESS</span>' : '<span class="bg-error-container text-error px-2 border border-error">EMPTY</span>';
    html += '<tr class="' + bg + ' hover:bg-primary-container hover:text-on-primary-container group cursor-pointer transition-colors"><td class="p-3 text-secondary-fixed-dim group-hover:text-on-primary-container">#' + (jobId||'').substring(0,8) + '</td><td class="p-3">' + escHtml(domain) + '</td><td class="p-3 text-on-surface-variant">' + ts + '</td><td class="p-3 font-bold text-secondary">' + ec.toLocaleString() + '</td><td class="p-3">' + status + '</td></tr>';
    idx++;
  });
  tbody.innerHTML = html;
  document.getElementById('db-total-records').textContent = 'TOTAL_RECORDS: ' + totalRecords.toLocaleString();
  let phtml = '<div class="mb-2 text-outline opacity-50 font-bold">// RAW_TEXT_OUTPUT [LAST_30]</div>';
  let count = 0;
  for (const [url,res] of items) {
    for (const em of (res.emails||[])) { if (count>=30) break; phtml += '<div class="mb-1 p-1 hover:bg-secondary/10 cursor-default">' + escHtml(em) + '</div>'; count++; }
    if (count>=30) break;
  }
  if (count===0) phtml += '<div class="text-on-surface-variant italic">[ NO_EXTRACTED_ENTITIES ]</div>';
  phtml += '<div class="mt-4 flex items-center gap-2"><span class="text-primary-fixed cursor-blink">█</span><span class="text-on-surface-variant italic">END OF BUFFER</span></div>';
  preview.innerHTML = phtml;
  document.getElementById('tel-jobs').textContent = sessionJobs;
  document.getElementById('tel-emails').textContent = sessionEmails.toLocaleString();
  document.getElementById('tel-phones').textContent = sessionPhones.toLocaleString();
  document.getElementById('footer-storage').textContent = 'LOCAL_STORAGE: ' + Math.min(Math.round(totalRecords/12500*100),100) + '% FULL';
  document.getElementById('dl-unique').onclick = () => { window.location.href = API + '/download/' + jobId + '/unique'; };
  document.getElementById('dl-summary').onclick = () => { window.location.href = API + '/download/' + jobId + '/summary'; };
  document.getElementById('dl-phones').onclick = () => { window.location.href = API + '/download/' + jobId + '/phones'; };
  document.getElementById('dl-json').onclick = () => { window.location.href = API + '/download/' + jobId + '/json'; };
}

// ═══ RECENT JOBS TABLE ═══
async function refreshJobs() {
  try {
    const res = await fetch(API + '/jobs');
    const jobs = await res.json();
    const tbody = document.getElementById('jobs-tbody');
    if (!jobs.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-on-surface-variant/50">[ NO_JOBS_REGISTERED ]</td></tr>';
      document.getElementById('jobs-count').textContent = 'SHOWING 0 JOBS';
      return;
    }
    let html = '';
    jobs.forEach(j => {
      let statusClass = 'text-on-surface-variant', statusText = 'QUEUED';
      if (j.status === 'running') { statusClass = 'text-secondary-fixed-dim'; statusText = 'IN_PROGRESS'; }
      else if (j.status === 'done') { statusClass = 'text-primary-fixed'; statusText = 'COMPLETED'; }
      html += '<tr class="border-b border-outline hover:bg-surface-variant/50"><td class="p-2 border-r border-outline text-secondary-fixed-dim">#' + j.job_id.substring(0,8) + '</td><td class="p-2 border-r border-outline">' + (j.timestamp||'—') + '</td><td class="p-2 border-r border-outline">' + j.total + ' URLS</td><td class="p-2 border-r border-outline"><span class="' + statusClass + '">[' + statusText + ']</span></td><td class="p-2 text-right"><button class="text-primary hover:underline" onclick="if(j.status===\'done\')switchScreen(\'results\')">[VIEW]</button></td></tr>';
    });
    tbody.innerHTML = html;
    document.getElementById('jobs-count').textContent = 'SHOWING ' + jobs.length + ' JOB' + (jobs.length!==1?'S':'');
    document.getElementById('sys-threads').textContent = jobs.filter(j=>j.status==='running').length + '/' + jobs.length;
  } catch(e) {}
}

// ═══ KEYBOARD SHORTCUTS ═══
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 't') { if (confirm('CONFIRM TERMINATION: DATA LOSS MAY OCCUR')) terminateJob(); }
  if (key === 'b') switchScreen('dashboard');
});

// ═══ CLOCK ═══
function updateClock() {
  const now = new Date();
  const s = now.toLocaleTimeString('en-GB',{hour12:false});
  document.getElementById('clock').textContent = s;
  document.getElementById('sys-clock').textContent = s;
}
setInterval(updateClock, 1000); updateClock();

// ═══ UTILITIES ═══
function escHtml(s) { if (!s) return ''; const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function formatBytes(b) { if (b<1024) return b+' B'; if (b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
let toastTimer;
function showToast(msg, type) {
  const t=document.getElementById('toast'); t.textContent=msg;
  t.className='fixed bottom-6 right-6 z-50 px-4 py-2 border font-mono text-[12px] shadow-2xl '+(type==='error'?'bg-error-container text-error border-error':'bg-surface text-primary border-outline');
  t.classList.remove('hidden'); clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.add('hidden'),4000);
}

// ═══ JITTER EFFECT (dashboard progress bars) ═══
setInterval(() => {
  const bars = document.querySelectorAll('.font-code-snippet.text-primary-container, .font-code-snippet.text-secondary-fixed-dim');
  bars.forEach(bar => {
    if (Math.random() > 0.8) { bar.style.opacity = '0.7'; setTimeout(() => bar.style.opacity = '1', 50); }
  });
}, 3000);

// ═══ INIT ═══
refreshJobs();
