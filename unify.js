const fs = require('fs');
const path = require('path');

const adminHtmlPath = path.join(__dirname, 'public/admin/index.html');
const dashHtmlPath = path.join(__dirname, 'public/dashboard/index.html');
const themeCssPath = path.join(__dirname, 'public/css/sv-theme.css');

let themeCss = fs.readFileSync(themeCssPath, 'utf8');
if (!themeCss.includes('/* Unified Components */')) {
  themeCss += `\n
/* Unified Components */

/* Buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 20px;border-radius:var(--radius);font-size:14px;font-weight:600;cursor:pointer;border:none;transition:all .14s;font-family:var(--sans);white-space:nowrap;}
.btn-primary{background:var(--accent);color:#fff;box-shadow:0 2px 12px rgba(124,108,250,.35);}
.btn-primary:hover{background:#6a5be8;box-shadow:0 4px 20px rgba(124,108,250,.45);transform:translateY(-1px);}
.btn-primary:active{transform:translateY(0);}
.btn-primary:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border2);}
.btn-ghost:hover{color:var(--text);background:var(--surface2);border-color:var(--border2);}
.btn-danger{background:rgba(248,113,113,.1);color:var(--red);border:1px solid rgba(248,113,113,.2);}
.btn-danger:hover{background:rgba(248,113,113,.18);}
.btn-success{background:rgba(34,211,165,.1);color:var(--green);border:1px solid rgba(34,211,165,.2);}
.btn-success:hover{background:rgba(34,211,165,.18);}
.btn-sm{padding:7px 14px;font-size:13px;}

/* Inputs, Selects, Filters */
.form-group, .modal-input-group{margin-bottom:14px;}
.form-group label, .modal-input-group label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--muted);display:block;margin-bottom:6px;}
.form-group input, .form-group select, .form-group textarea,
.modal-input, .modal-textarea,
.search-input, .filter-select, .header-search, .guest-login input, .library-toolbar select {
  background:var(--surface2);border:1px solid var(--border2);border-radius:var(--radius);color:var(--text);padding:10px 14px;font-size:13px;font-family:var(--sans);outline:none;transition:border-color .15s, background .15s; width:100%; box-sizing: border-box;
}
.form-group input:focus, .form-group select:focus, .form-group textarea:focus,
.modal-input:focus, .modal-textarea:focus,
.search-input:focus, .filter-select:focus, .header-search:focus, .guest-login input:focus, .library-toolbar select:focus {
  border-color:var(--accent); background:var(--surface3); box-shadow: var(--focus-ring);
}

.search-input, .header-search { padding-left: 36px; }
.search-wrap { position:relative; width: 100%; }
.search-wrap svg { position:absolute; left:11px; top:50%; transform:translateY(-50%); opacity:.4; pointer-events:none; }
.filter-select, .library-toolbar select { padding: 8px 12px; width: auto; }
.guest-login input { padding: 7px 11px; width: 150px; }
.guest-login input#auth-pass { width: 125px; }

/* Modals */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(8px);z-index:1000;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s;padding:20px;}
.modal-overlay.visible{opacity:1;pointer-events:auto;}
.modal-card{background:var(--surface);border:1px solid var(--border2);border-radius:20px;width:100%;max-width:560px;box-shadow:0 32px 100px rgba(0,0,0,.6);transform:scale(.9) translateY(10px);transition:transform .25s;overflow:hidden;}
.modal-card.wide{max-width:720px;}
.modal-overlay.visible .modal-card{transform:scale(1) translateY(0);}
.modal-head{padding:24px 28px 12px;display:flex;align-items:center;justify-content:space-between;}
.modal-head h3{font-size:1.15rem;font-weight:700;}
.modal-body{padding:0 28px 20px;color:var(--muted);font-size:14px;line-height:1.6;max-height:70vh;overflow-y:auto;}
.modal-foot{padding:16px 28px 24px;display:flex;justify-content:flex-end;gap:12px;background:rgba(255,255,255,.02);border-top:1px solid var(--border);}

/* Toasts */
.toast{position:fixed;bottom:24px;right:24px;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--radius-lg);padding:12px 18px;font-size:14px;z-index:9999;opacity:0;transform:translateY(8px);transition:all .2s;display:flex;align-items:center;gap:8px;min-width:200px;box-shadow:0 12px 40px rgba(0,0,0,.4);}
.toast.show{opacity:1;transform:translateY(0);}
.toast.success{border-color:rgba(34,211,165,.3);color:var(--green);}
.toast.error{border-color:rgba(248,113,113,.3);color:var(--red);}
`;
  fs.writeFileSync(themeCssPath, themeCss);
}

// Remove from admin
let adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');

// Regex to remove the blocks
const adminToRemove = [
  /\.btn\{[^\}]+\}/g,
  /\.btn-primary\{[^\}]+\}/g,
  /\.btn-primary:hover\{[^\}]+\}/g,
  /\.btn-primary:disabled\{[^\}]+\}/g,
  /\.btn-ghost\{[^\}]+\}/g,
  /\.btn-ghost:hover\{[^\}]+\}/g,
  /\.btn-danger\{[^\}]+\}/g,
  /\.btn-danger:hover\{[^\}]+\}/g,
  /\.btn-success\{[^\}]+\}/g,
  /\.btn-success:hover\{[^\}]+\}/g,
  /\.btn-sm\{[^\}]+\}/g,
  
  /\.search-wrap\{[^\}]+\}/g,
  /\.search-wrap svg\{[^\}]+\}/g,
  /\.search-input\{[^\}]+\}/g,
  /\.search-input:focus\{[^\}]+\}/g,
  /\.filter-select\{[^\}]+\}/g,
  /\.filter-select:focus\{[^\}]+\}/g,
  
  /\.toast\{[^\}]+\}/g,
  /\.toast\.show\{[^\}]+\}/g,
  /\.toast\.success\{[^\}]+\}/g,
  /\.toast\.error\{[^\}]+\}/g,
  
  /\.modal-overlay\{[^\}]+\}/g,
  /\.modal-overlay\.visible\{[^\}]+\}/g,
  /\.modal-card\{[^\}]+\}/g,
  /\.modal-card\.wide\{[^\}]+\}/g,
  /\.modal-overlay\.visible \.modal-card\{[^\}]+\}/g,
  /\.modal-head\{[^\}]+\}/g,
  /\.modal-head h3\{[^\}]+\}/g,
  /\.modal-body\{[^\}]+\}/g,
  /\.modal-foot\{[^\}]+\}/g,
  
  /\.form-group\{[^\}]+\}/g,
  /\.form-group label\{[^\}]+\}/g,
  /\.form-group input,\.form-group select,\.form-group textarea\{[^\}]+\}/g,
  /\.form-group input:focus,\.form-group select:focus,\.form-group textarea:focus\{[^\}]+\}/g,
];

for (const regex of adminToRemove) {
  adminHtml = adminHtml.replace(regex, '');
}
// Clean up empty lines created by replacements in style tag
adminHtml = adminHtml.replace(/\n\s*\n/g, '\n');
fs.writeFileSync(adminHtmlPath, adminHtml);


// Remove from dashboard
let dashHtml = fs.readFileSync(dashHtmlPath, 'utf8');
const dashToRemoveStrings = [
  `    .header-search-wrap {
      position: relative;
      width: 100%;
    }`,
  `    .header-search-wrap svg {
      position: absolute;
      left: 11px;
      top: 50%;
      transform: translateY(-50%);
      opacity: 0.4;
      pointer-events: none;
    }`,
  `    .header-search {
      width: 100%;
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: 9px;
      color: var(--text);
      padding: 8px 12px 8px 36px;
      font-size: 13px;
      font-family: var(--sans);
      outline: none;
      transition: border-color 0.15s, background 0.15s;
    }`,
  `    .header-search:focus {
      border-color: var(--accent);
      background: var(--surface3);
    }`,
  `    .guest-login input {
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: 7px;
      color: var(--text);
      padding: 7px 11px;
      font-size: 13px;
      font-family: var(--sans);
      outline: none;
      width: 150px;
    }`,
  `    .guest-login input#auth-pass {
      width: 125px;
    }`,
  `    .guest-login input:focus {
      border-color: var(--accent);
    }`,
  `    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border-radius: var(--radius);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.14s;
      font-family: var(--sans);
      white-space: nowrap;
    }`,
  `    .btn-primary {
      background: var(--accent);
      color: #fff;
      box-shadow: 0 2px 12px rgba(124, 108, 250, 0.35);
    }`,
  `    .btn-primary:hover {
      background: #6a5be8;
      box-shadow: 0 4px 20px rgba(124, 108, 250, 0.45);
      transform: translateY(-1px);
    }`,
  `    .btn-primary:active {
      transform: translateY(0);
    }`,
  `    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }`,
  `    .btn-ghost {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border2);
    }`,
  `    .btn-ghost:hover {
      color: var(--text);
      background: var(--surface2);
      border-color: var(--border2);
    }`,
  `    .btn-danger {
      background: rgba(248, 113, 113, 0.1);
      color: var(--red);
      border: 1px solid rgba(248, 113, 113, 0.2);
    }`,
  `    .btn-danger:hover {
      background: rgba(248, 113, 113, 0.18);
    }`,
  `    .library-toolbar select {
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: var(--radius);
      color: var(--text);
      padding: 8px 12px;
      font-size: 13px;
      font-family: var(--sans);
      outline: none;
      transition: border-color 0.14s;
    }`,
  `    .library-toolbar select:focus {
      border-color: var(--accent);
    }`,
  `    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: var(--radius-lg);
      padding: 12px 18px;
      font-size: 14px;
      z-index: 9999;
      opacity: 0;
      transform: translateY(8px);
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 200px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    }`,
  `    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }`,
  `    .toast.success {
      border-color: rgba(34, 211, 165, 0.3);
      color: var(--green);
    }`,
  `    .toast.error {
      border-color: rgba(248, 113, 113, 0.3);
      color: var(--red);
    }`,
  `    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(8px);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
      padding: 20px;
    }`,
  `    .modal-overlay.visible {
      opacity: 1;
      pointer-events: auto;
    }`,
  `    .modal-card {
      background: var(--surface);
      border: 1px solid var(--border2);
      border-radius: 20px;
      width: 100%;
      max-width: 560px;
      box-shadow: 0 32px 100px rgba(0, 0, 0, 0.6);
      transform: scale(0.9) translateY(10px);
      transition: transform 0.25s;
      overflow: hidden;
    }`,
  `    .modal-overlay.visible .modal-card {
      transform: scale(1) translateY(0);
    }`,
  `    .modal-head {
      padding: 24px 28px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }`,
  `    .modal-head h3 {
      font-size: 1.15rem;
      font-weight: 700;
    }`,
  `    .modal-body {
      padding: 0 28px 20px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
      max-height: 70vh;
      overflow-y: auto;
    }`,
  `    .modal-foot {
      padding: 16px 28px 24px;
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      background: rgba(255, 255, 255, 0.02);
      border-top: 1px solid var(--border);
    }`,
  `    .modal-input-group {
      margin-bottom: 16px;
    }`,
  `    .modal-input-group label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--muted);
      margin-bottom: 6px;
    }`,
  `    .modal-input {
      width: 100%;
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: var(--radius);
      padding: 10px 14px;
      font-size: 13px;
      font-family: var(--sans);
      color: var(--text);
      outline: none;
      transition: border-color 0.15s;
    }`,
  `    .modal-input:focus {
      border-color: var(--accent);
    }`,
  `    .modal-textarea {
      width: 100%;
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: var(--radius);
      padding: 10px 14px;
      font-size: 13px;
      font-family: var(--sans);
      color: var(--text);
      outline: none;
      transition: border-color 0.15s;
      resize: vertical;
      min-height: 80px;
    }`,
  `    .modal-textarea:focus {
      border-color: var(--accent);
    }`
];

for (const str of dashToRemoveStrings) {
  dashHtml = dashHtml.replace(str, '');
}

fs.writeFileSync(dashHtmlPath, dashHtml);
console.log('Unified styles successfully extracted to sv-theme.css and removed from HTML files.');
