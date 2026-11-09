'use strict';
(function pages(module) {
const name = 'Σταυροδρόμι Κοινότητα';
const about = 'Ιστορία, μνήμη και ανεξάρτητο ρεπορτάζ για το Σταυροδρόμι Γορτυνίας.';
const sections = {
  reportaz: ['Ρεπορτάζ & Παρεμβάσεις','Έργα, αποφάσεις και ερωτήματα για την κοινότητα.'],
  history: ['Ιστορία & Μνήμη','Τεκμήρια, μαρτυρίες και η διαδρομή του χωριού.'],
  laografia: ['Λαογραφία & Πολιτισμός','Έθιμα, λέξεις και μνήμες της καθημερινής ζωής.'],
  autodioikisi: ['Αυτοδιοίκηση & Κοινωνία','Υποθέσεις της κοινότητας και η εξέλιξή τους.'],
};
const statuses = { pending:'Χωρίς απάντηση', tracking:'Σε παρακολούθηση', answered:'Απαντήθηκε' };
const link = id => '/' + id + '.html';
const articleUrl = id => '/article-' + encodeURIComponent(id) + '.html';
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const calendar = new Intl.DateTimeFormat('el-GR', { dateStyle:'long', timeZone:'Europe/Athens' });
const time = value => `<time datetime="${e(value)}">${calendar.format(new Date(value + 'T12:00:00Z'))}</time>`;
const allowed = new Set('p div span br hr h2 h3 h4 strong b em i u s ul ol li blockquote a img figure figcaption table thead tbody tr th td dl dt dd details summary sup sub'.split(' '));
const empty = new Set(['br','hr','img']);
const safeUrl = value => typeof value === 'string' && value.length <= 1600 && !/[\\\u0000-\u0020\u007f]/.test(value) && /^(?:\/(?!\/)|https:\/\/)/i.test(value);
function rich(nodes, depth = 0) {
  if (!Array.isArray(nodes) || depth > 30) return '';
  return nodes.map(node => {
    if (typeof node === 'string') return e(node);
    if (!node || !allowed.has(node.tag)) return '';
    let attr = '';
    if (node.tag === 'a' && (safeUrl(node.href) || typeof node.href === 'string' && /^#[a-z0-9_-]+$/i.test(node.href))) attr = ` href="${e(node.href)}" rel="noopener"`;
    if (node.tag === 'img') {
      if (!safeUrl(node.src)) return '';
      attr = ` src="${e(node.src)}" alt="${e(node.alt)}" loading="lazy"`;
    }
    return `<${node.tag}${attr}>` + (empty.has(node.tag) ? '' : rich(node.children, depth + 1) + `</${node.tag}>`);
  }).join('');
}
function layout(body, { origin, p = '/', title, summary = about, image, article = false, privatePage = false, admin = false }) {
  const url = origin + p;
  const activePath = p.startsWith('/afieroma/') ? link(p.split('/').at(-1)) : p;
  const shareImage = image?.startsWith('data:') ? '' : new URL(image || '/images/history/stavrodromi-plateia.jpg', origin).href;
  const nav = [['/','Αρχική'], ['/reportaz.html','Ρεπορτάζ'], ['/history.html','Ιστορία & Μνήμη'],
    ['/laografia.html','Λαογραφία'], ['/autodioikisi.html','Αυτοδιοίκηση'], ['/paratiritirio','Παρατηρητήριο']];
  return `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${e(title ? title + ' | ' + name : name)}</title><meta name="description" content="${e(summary)}">
  ${privatePage ? '<meta name="robots" content="noindex,nofollow">' :
  `<link rel="canonical" href="${e(url)}"><meta property="og:type" content="${article ? 'article' : 'website'}">
  <meta property="og:locale" content="el_GR"><meta property="og:site_name" content="${name}"><meta property="og:url" content="${e(url)}">
  <meta property="og:title" content="${e(title || name)}"><meta property="og:description" content="${e(summary)}">
  <meta property="og:image" content="${e(shareImage)}"><meta name="twitter:card" content="summary_large_image">`}
  <link rel="stylesheet" href="/site.css"></head><body><a class="skip" href="#main">Μετάβαση στο περιεχόμενο</a>
  <header class="mast"><div class="utility"><div class="wrap">Γορτυνία · Αρκαδία <a href="/epikoinonia.html">Επικοινωνία</a></div></div>
  <div class="brand wrap"><a href="/" class="wordmark">Σταυροδρόμι<span>ΚΟΙΝΟΤΗΤΑ</span></a>
  <p>Ιστορία, μνήμη και δημόσιος λόγος<br>για ένα χωριό της Γορτυνίας</p></div>
  <nav class="nav" aria-label="Κύριο μενού"><div class="wrap">${nav.map(([href,label]) =>
    `<a href="${href}"${activePath === href ? ' aria-current="page"' : ''}>${e(label)}</a>`).join('')}</div></nav></header>
  <main class="wrap main" id="main">${body}</main>
  <footer class="footer"><div class="wrap"><div><strong>${name}</strong><p>Ανεξάρτητος χώρος καταγραφής για το Σταυροδρόμι Γορτυνίας.</p></div>
  <div><a href="/sxetika.html">Σχετικά</a><a href="/epikoinonia.html">Επικοινωνία</a><a href="/arxeio">Αρχείο</a><a href="/admin">Διαχείριση</a></div></div></footer>
  ${admin ? '<script src="/editor.js" defer></script>' : ''}</body></html>`;
}
const sorted = all => Object.values(all).filter(item => !item.archived).sort((a,b) => b.date.localeCompare(a.date));
const label = item => sections[item.sections[0]][0];
const photo = (item, eager = false) => item.image ? `<img src="${e(item.image)}" alt="${e(item.alt)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async">` : '';
const head = (title, more = '') => `<div class="section-head"><h2>${e(title)}</h2>${more}</div>`;
const cards = items => items.length ? `<div class="cards">${items.map(item => `<article class="card">
  <a class="card-photo" href="${articleUrl(item.id)}" tabindex="-1" aria-hidden="true">${photo(item)}</a>
  <div class="card-copy"><div class="eyebrow">${e(label(item))}</div><h3><a href="${articleUrl(item.id)}">${e(item.title)}</a></h3>
  <p>${e(item.summary)}</p>${time(item.date)}</div></article>`).join('')}</div>` : '<p class="notice">Δεν βρέθηκαν κείμενα.</p>';
const issue = item => `<li><div><strong>${item.article ? `<a href="${articleUrl(item.article)}">${e(item.title)}</a>` : e(item.title)}</strong>
  ${time(item.date)}${item.update ? `<p>${e(item.update)}</p>` : ''}</div><span class="status ${e(item.status)}">${e(statuses[item.status])}</span></li>`;
const intro = (kicker,title,summary) => `<div class="page-intro"><div class="eyebrow">${e(kicker)}</div><h1>${e(title)}</h1><p>${e(summary)}</p></div>`;
const options = values => Object.entries(values).map(([key,value]) => `<option value="${key}">${e(Array.isArray(value) ? value[0] : value)}</option>`).join('');
const normalize = value => value.toLocaleLowerCase('el').normalize('NFD').replace(/\p{M}/gu,'').replace(/ς/g,'σ').trim();

function render(kind, params) {
  const { origin, p, all, state, article, category, q, local, preview, information } = params;
  if (kind === 'home') {
    const items = sorted(all);
    const lead = all[state.featured] || items[0];
    const recent = items.filter(item => item.id !== lead.id).slice(0,6);
    return layout(`<h1 class="sr-only">${name}</h1>
      <section class="lead"><a class="lead-photo" href="${articleUrl(lead.id)}" tabindex="-1" aria-hidden="true">${photo(lead,true)}</a>
      <div class="lead-copy"><div class="eyebrow">Κύριο θέμα · ${e(label(lead))}</div><h2><a href="${articleUrl(lead.id)}">${e(lead.title)}</a></h2>
      <p>${e(lead.summary)}</p>${time(lead.date)}<a class="text-link" href="${articleUrl(lead.id)}">Διάβασε το άρθρο ↗</a></div></section>
      <div class="front-grid"><section>${head('Πρόσφατα κείμενα','<a href="/arxeio">Όλο το αρχείο ↗</a>')}${cards(recent)}</section>
      <aside>${head('Παρατηρητήριο')}<div class="issue-panel"><p>Τοπικές υποθέσεις και οι τελευταίες εξελίξεις τους.</p>
      <ul class="issues">${state.issues.slice(0,4).map(issue).join('')}</ul><a class="text-link" href="/paratiritirio">Όλα τα ζητήματα ↗</a></div></aside></div>
      <section class="topics">${head('Θεματικές ενότητες')}<div class="topic-grid">${Object.entries(sections).map(([id,[title,desc]]) =>
        `<a href="${link(id)}"><h3>${e(title)}</h3><p>${e(desc)}</p></a>`).join('')}</div></section>`, { origin });
  }
  if (kind === 'archive') {
    const [title,summary] = sections[category] || ['Αρχείο κειμένων','Δημοσιεύσεις ανά ενότητα και αναζήτηση με λέξεις.'];
    const items = sorted(all).filter(item => (!category || item.sections.includes(category)) &&
      (!q || normalize(item.title + ' ' + item.summary).includes(normalize(q))));
    return layout(`${intro('Κείμενα',title,summary)}
      <form class="search" action="${p}"><label class="sr-only" for="q">Αναζήτηση κειμένων</label>
      <input id="q" name="q" type="search" maxlength="100" placeholder="Αναζήτηση κειμένων" value="${e(q)}"><button>Αναζήτηση</button></form>
      <div class="filters">${[['','Όλα'],...Object.entries(sections).map(([key,[label]]) => [key,label])].map(([id,label]) =>
      `<a href="${id ? link(id) : '/arxeio'}"${(category || '') === id ? ' aria-current="page"' : ''}>${e(label)}</a>`).join('')}</div>
      ${category && category !== 'reportaz' ? `<p><a class="text-link" href="/afieroma/${category}">Διάβασε το αφιέρωμα της ενότητας ↗</a></p>` : ''}${cards(items)}`,
      { origin,p,title,summary });
  }
  if (kind === 'information') {
    const { title, summary, image, heading, body, sidebar } = information;
    return layout(`<div class="page-intro">${heading}</div>
      <div class="information-page${sidebar ? ' front-grid' : ''}">
        <div class="information-body reading">${body}</div>
        ${sidebar ? `<aside class="information-sidebar" aria-label="Συμπληρωματικές πληροφορίες">${sidebar}</aside>` : ''}
      </div>`, { origin, p, title, summary, image });
  }
  if (kind === 'issues') {
    return layout(`${intro('Αυτοδιοίκηση','Παρατηρητήριο','Οι υποθέσεις της κοινότητας, οι απαντήσεις και όσα παραμένουν ανοιχτά.')}
      <div class="observatory">${Object.entries(statuses).map(([status,label]) => {
      const items = state.issues.filter(item => item.status === status).sort((a,b) => b.date.localeCompare(a.date));
      return `<section>${head(label)}<ul class="issues">${items.map(issue).join('') || '<li>Κανένα ζήτημα.</li>'}</ul></section>`;
      }).join('')}</div>`, { origin,p,title:'Παρατηρητήριο Αυτοδιοίκησης' });
  }
  if (kind === 'article') {
    const address = articleUrl(article.id);
    const related = sorted(all).filter(item => item.id !== article.id && item.sections.includes(article.sections[0])).slice(0,3);
    return layout(`<article class="story"><header class="story-head"><a class="eyebrow" href="${link(article.sections[0])}">${e(label(article))}</a>
      <h1>${e(article.title)}</h1>${article.deck ? `<p class="deck">${e(article.deck)}</p>` : ''}
      <p class="byline">${time(article.date)}${article.author ? ' · ' + e(article.author) : ''}</p>
      ${article.archived ? '<p class="notice">Προγενέστερη εκδοχή. <a href="/article-gortynias-parakampsi-lagkadia.html">Νεότερη δημοσίευση</a></p>' : ''}</header>
      ${article.hero && article.image ? `<figure class="hero-figure">${photo(article,true)}${article.caption ? '<figcaption>' + e(article.caption) + '</figcaption>' : ''}</figure>` : ''}
      <div class="reading article-body">${article.body}</div>
      ${preview ? '' : `<div class="story-actions"><a href="${link(article.sections[0])}">Πίσω στην ενότητα</a>
        <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(origin + address)}" rel="noopener noreferrer">Κοινοποίηση στο Facebook</a></div>`}</article>
      ${related.length ? '<section class="topics">' + head('Σχετικά κείμενα') + cards(related) + '</section>' : ''}`,
      { origin,p:address,title:article.title,summary:article.summary,image:article.image,article:true,privatePage:preview });
  }
  if (kind === 'admin') return layout(`${intro('Σύνταξη','Διαχείριση','Άρθρα, κύριο θέμα και ενημερώσεις στο Παρατηρητήριο.')}
    <p id="feedback" role="status" aria-live="polite"></p>
    <section class="panel narrow" id="login-panel"><h2>Σύνδεση διαχειριστή</h2><form id="login">
    <label>${local ? 'Κωδικός δοκιμής' : 'Κλειδί πρόσβασης GitHub'}<input type="password" id="key" maxlength="300" required autocomplete="off"></label>
    ${local ? '' : '<p>Χρησιμοποίησε κλειδί περιορισμένο στο αποθετήριο stavrodromio, με άδεια Contents: Read and write.</p>'}
    <button>Σύνδεση</button></form></section>
    <div id="desk" hidden><div class="desk-top"><button id="new-article">Νέο άρθρο</button><button id="logout" class="secondary">Αποσύνδεση</button></div>
    <div class="editor-grid"><aside class="panel"><h2>Δημοσιεύσεις</h2><div id="article-list" class="editor-list"></div></aside>
    <section class="panel"><h2 id="edit-title">Νέο άρθρο</h2><form id="article-form">
    <label>Τίτλος <input name="title" required maxlength="240"></label>
    <div class="form-grid"><label>Κύρια ενότητα <select name="category">${options(sections)}</select></label>
    <label>Ημερομηνία <input type="date" name="date" required></label></div>
    <label>Συντάκτης <input name="author" maxlength="120"></label>
    <label>Σύντομη περιγραφή <textarea name="summary" rows="2" maxlength="800" required></textarea></label>
    <label>Εισαγωγή άρθρου <textarea name="deck" rows="3" maxlength="2400"></textarea></label>
    <div class="form-grid"><label>Φωτογραφία εξωφύλλου <input type="file" name="cover" accept="image/jpeg,image/png,image/webp"></label>
    <label>ή διεύθυνση εικόνας <input name="image" maxlength="1600"></label></div>
    <div class="form-grid"><label>Περιγραφή εικόνας <input name="alt" maxlength="300"></label><label>Λεζάντα <input name="caption" maxlength="500"></label></div>
    <div class="toolbar"><label><input type="checkbox" name="hero"> Εικόνα μέσα στο άρθρο</label><label><input type="checkbox" name="featured"> Κύριο θέμα της αρχικής</label></div>
    <span id="body-label">Κείμενο άρθρου</span>
    <div class="toolbar" role="group" aria-label="Μορφοποίηση κειμένου"><button type="button" data-format="bold">Έντονα</button>
    <button type="button" data-format="italic">Πλάγια</button><button type="button" data-format="formatBlock" data-value="h2">Μεσότιτλος</button>
    <button type="button" data-format="formatBlock" data-value="p">Παράγραφος</button><button type="button" data-format="insertUnorderedList">Λίστα</button>
    <button type="button" data-format="createLink">Σύνδεσμος</button></div>
    <div id="body-editor" class="reading" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="body-label"></div>
    <div class="toolbar"><button type="button" id="preview" class="secondary">Προεπισκόπηση</button><button id="publish">Δημοσίευση</button></div></form></section></div>
    <section class="panel issue-editor"><h2>Παρατηρητήριο</h2><form id="issue-form">
    <label>Υπόθεση <select id="issue-select"></select></label><label>Τίτλος <input name="title" required maxlength="240"></label>
    <div class="form-grid"><label>Κατάσταση <select name="status">${options(statuses)}</select></label><label>Ημερομηνία <input name="date" type="date" required></label></div>
    <label>Σχετικό άρθρο <select id="issue-article" name="article"></select></label>
    <label>Νεότερη ενημέρωση <textarea name="update" rows="3" maxlength="2000"></textarea></label><button>Αποθήκευση στο Παρατηρητήριο</button></form></section></div>
    <dialog id="preview-dialog"><div><button id="close-preview" class="secondary">Κλείσιμο</button></div><iframe title="Προεπισκόπηση άρθρου" id="preview-frame" sandbox></iframe></dialog>`,
    { origin,p:'/admin',title:'Διαχείριση',admin:true,privatePage:true });
  return layout(`${intro('Σταυροδρόμι','Η σελίδα δεν είναι διαθέσιμη','Δες τα διαθέσιμα κείμενα στο αρχείο.')}<a href="/arxeio">Αρχείο κειμένων</a>`,
    { origin,title:'Η σελίδα δεν είναι διαθέσιμη',privatePage:true });
}
module.exports = { render, sections, statuses, articleUrl, rich, safeUrl };
})(module);
