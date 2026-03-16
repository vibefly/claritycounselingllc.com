// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function computeTurnstileTheme(theme) {
  if (!theme) return 'auto';
  const bg = theme.bg || '#ffffff';
  const hex = bg.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? 'light' : 'dark';
}

async function verifyTurnstile(token, ip, secretKey) {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretKey, response: token, remoteip: ip }),
  });
  const data = await res.json();
  return data.success === true;
}

async function sendEmail(env, fields, formCfg, bizName) {
  const to      = env.CONTACT_EMAIL || '';
  const from    = env.FROM_EMAIL    || `noreply@${env.DOMAIN || 'example.com'}`;
  const subject = `New enquiry from ${fields.name || 'your website'} — ${bizName || 'Website'}`;

  const rows = Object.entries(fields)
    .filter(([k]) => k !== 'cf-turnstile-response')
    .map(([k, v]) => `<tr><td style="padding:6px 12px;font-weight:600;white-space:nowrap;color:#555;border-bottom:1px solid #eee">${escHtml(k)}</td><td style="padding:6px 12px;border-bottom:1px solid #eee">${escHtml(String(v))}</td></tr>`)
    .join('');

  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#222;max-width:600px;margin:0 auto">
<h2 style="background:#7C6E64;color:#fff;padding:16px 20px;margin:0;border-radius:6px 6px 0 0">New Enquiry — ${escHtml(bizName || 'Website')}</h2>
<table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-top:none">${rows}</table>
</body></html>`;

  const payload = { to: [{ email: to }], from: { email: from }, subject, html };

  if (env.SENDGRID_API_KEY) {
    await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: payload.to }],
        from: payload.from,
        subject: payload.subject,
        content: [{ type: 'text/html', value: payload.html }],
      }),
    });
    return;
  }

  if (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN) {
    const form = new FormData();
    form.append('from', from);
    form.append('to', to);
    form.append('subject', subject);
    form.append('html', html);
    await fetch(`https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` },
      body: form,
    });
    return;
  }

  console.log('No email provider configured. Payload:', JSON.stringify(payload));
}

async function handleSubmit(request, env) {
  try {
    const contentType = request.headers.get('Content-Type') || '';
    let fields;

    if (contentType.includes('application/json')) {
      fields = await request.json();
    } else {
      const form = await request.formData();
      fields = Object.fromEntries(form.entries());
    }

    // Turnstile verification
    const contentRes  = await env.ASSETS.fetch(new Request(new URL('/content.json', request.url).href));
    const contentJson = contentRes.ok ? await contentRes.json() : {};
    const formCfg     = contentJson.form || {};
    const bizName     = (contentJson.business && contentJson.business.name) || '';

    if (formCfg.turnstileSiteKey && env.TURNSTILE_SECRET) {
      const token = fields['cf-turnstile-response'];
      const ip    = request.headers.get('CF-Connecting-IP') || '';
      const ok    = await verifyTurnstile(token, ip, env.TURNSTILE_SECRET);
      if (!ok) return jsonError('Security check failed. Please try again.', 403);
    }

    await sendEmail(env, fields, formCfg, bizName);
    return jsonOk({ ok: true, message: formCfg.deliveredMessage || 'Message sent.' });

  } catch (err) {
    console.error('handleSubmit error:', err);
    return jsonError('Server error. Please try again later.', 500);
  }
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/submit') {
      return handleSubmit(request, env);
    }

    if (request.method === 'GET') {
      if (/\.(css|js|json|ico|png|jpg|jpeg|svg|webp|woff2?)$/i.test(url.pathname)) {
        return env.ASSETS.fetch(request);
      }
      return renderPage(env, url);
    }

    return env.ASSETS.fetch(request);
  }
};

// ─── Page Renderer ────────────────────────────────────────────────────────────

async function renderPage(env, url) {
  try {
    const [htmlRes, contentRes] = await Promise.all([
      env.ASSETS.fetch(new Request(new URL('/index.html', url).href)),
      env.ASSETS.fetch(new Request(new URL('/content.json', url).href)),
    ]);

    if (!htmlRes.ok || !contentRes.ok) return env.ASSETS.fetch(new Request(url.href));

    const [html, content] = await Promise.all([htmlRes.text(), contentRes.json()]);

    const biz     = content.business || {};
    const formCfg = content.form     || {};
    if (!formCfg.thankYouSub && formCfg.thankYouSubtext) formCfg.thankYouSub = formCfg.thankYouSubtext;
    if (!formCfg.thankYouSubtext && formCfg.thankYouSub) formCfg.thankYouSubtext = formCfg.thankYouSub;

    const slug     = url.pathname.replace(/^\/+/, '').replace(/\/.*$/, '') || 'home';
    const pageData = (content.pages && content.pages[slug]) || content.pages?.home || null;
    const sections = (pageData && pageData.sections) || [];
    const nav      = Array.isArray(content.nav) ? content.nav : [];
    const phone    = biz.phone || '';
    const phoneHref = biz.phoneHref || (phone ? `tel:${phone.replace(/\D/g, '')}` : '#');

    function resolve(path) {
      return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), content);
    }

    // Head
    const titleText  = (content.meta && content.meta.title)       || biz.name || '';
    const description = (content.meta && content.meta.description) || '';
    const canonical   = url.origin + url.pathname;
    const ogTags = [
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${escAttr(canonical)}">`,
      `<meta property="og:title" content="${escAttr(titleText)}">`,
      `<meta property="og:description" content="${escAttr(description)}">`,
    ].join('\n');

    let siteImages = [];
    try {
      const imagesRes = await env.ASSETS.fetch(new Request(new URL('/images.json', url).href));
      if (imagesRes.ok) siteImages = await imagesRes.json();
    } catch { /* no images */ }

    const inlineScripts = `<script>window.__BUSINESS=${JSON.stringify(biz)};window.__FORM_CONFIG=${JSON.stringify(formCfg)};window.__IMAGES=${JSON.stringify(siteImages)};</script>`;

    // CSS variable injection from theme
    const theme = content.theme || {};
    const cssVars = Object.entries({
      '--bg':                theme.bg              || '#FAF9F7',
      '--bg-alt':            theme.bgAlt           || '#F2EEE9',
      '--bg-dark':           theme.bgDark          || '#2C2825',
      '--accent-primary':    theme.accentPrimary   || '#7C6E64',
      '--accent-secondary':  theme.accentSecondary || '#B5A89A',
      '--accent-light':      theme.accentLight     || '#EDE6DE',
      '--text-primary':      theme.textPrimary     || '#2C2825',
      '--text-secondary':    theme.textSecondary   || '#7C6E64',
      '--hero-start':        theme.heroStart       || '#FAF9F7',
      '--hero-mid':          theme.heroMid         || '#F5F0EA',
      '--hero-end':          theme.heroEnd         || '#EDE6DE',
      '--color-star':        theme.star            || '#C8A96E',
      '--border-card':       theme.borderCard      || '#E8E1D9',
      '--border-card-hover': theme.borderCardHover || '#B5A89A',
    }).map(([k, v]) => `  ${k}: ${v};`).join('\n');

    const themeStyle = `<style id="theme-vars">:root {\n${cssVars}\n}</style>`;

    let modifiedHtml = html;
    modifiedHtml = modifiedHtml.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(titleText)}</title>`);
    modifiedHtml = modifiedHtml.replace(/(<meta name="description" content=")[^"]*(")/,
      `$1${escAttr(description)}$2`);
    modifiedHtml = modifiedHtml.replace('</head>', `${ogTags}\n${themeStyle}\n${inlineScripts}\n</head>`);

    // Body content
    const navHtml = nav.map(item =>
      `<li><a class="nav-link" href="${escAttr(item.href || '#')}">${escHtml(item.label || '')}</a></li>`
    ).join('');

    const sectionsHtml = sections.map((sec, idx) => renderSection(sec, idx)).join('\n');

    // Form fields
    let fieldsHtml = '';
    if (formCfg.fields) {
      fieldsHtml = formCfg.fields.map(field => {
        const id  = `contact-${field.name}`;
        const req = field.required ? ' required' : '';
        let inputHtml;
        if (field.type === 'textarea') {
          inputHtml = `<textarea id="${id}" name="${escAttr(field.name)}" rows="${field.rows || 4}" placeholder="${escAttr(field.placeholder || '')}"${req}></textarea>`;
        } else if (field.type === 'select') {
          const opts = (field.options || []).map(o =>
            `<option value="${escAttr(String(o.value))}">${escHtml(String(o.label))}</option>`
          ).join('');
          inputHtml = `<select id="${id}" name="${escAttr(field.name)}"${req}><option value="">${escHtml(field.placeholder || 'Select…')}</option>${opts}</select>`;
        } else {
          inputHtml = `<input type="${escAttr(field.type || 'text')}" id="${id}" name="${escAttr(field.name)}" placeholder="${escAttr(field.placeholder || '')}"${req}>`;
        }
        return `<label for="${id}">${escHtml(field.label || '')}</label>${inputHtml}`;
      }).join('\n');
    }

    let tsHtml = '';
    if (formCfg.turnstileSiteKey) {
      const tsTheme = computeTurnstileTheme(content.theme);
      tsHtml = `<div class="cf-turnstile" data-sitekey="${escAttr(formCfg.turnstileSiteKey)}" data-theme="${tsTheme}"></div>`;
    }

    const serviceAreas = (content.contact && content.contact.serviceAreas) || [];
    const areasText     = serviceAreas.join(', ');
    const areasListHtml = serviceAreas.map(a => `<li>${escHtml(a)}</li>`).join('');

    const hours     = (content.contact && content.contact.hours) || [];
    const hoursHtml = `<strong>Hours</strong>${hours.map(h => `<span>${escHtml(h)}</span>`).join('')}`;

    // Footer services: first section with non-testimonial items
    const footerSvc = sections.find(s => s.items && s.items.length > 0 && !s.items[0].quote);
    const footerSvcHtml = footerSvc ? footerSvc.items.map(item =>
      `<li><a href="#${escAttr(footerSvc.id || 'services')}">${escHtml(item.title || '')}</a></li>`
    ).join('') : '';

    const rewriter = new HTMLRewriter()
      .on('body', {
        element(el) {
          const cls = el.getAttribute('class') || '';
          el.setAttribute('class', (cls + ' content-loaded').trim());
        }
      })
      .on('[data-content]', {
        element(el) {
          const val = resolve(el.getAttribute('data-content'));
          if (val != null) el.setInnerContent(String(val));
        }
      })
      .on('[data-content-attr-href]', {
        element(el) {
          const val = resolve(el.getAttribute('data-content-attr-href'));
          if (val) el.setAttribute('href', String(val));
        }
      })
      .on('[data-content-nav]', {
        element(el) { el.setInnerContent(navHtml, { html: true }); }
      })
      .on('[data-content-phone]', {
        element(el) {
          el.setInnerContent(phone);
          if (el.tagName === 'a') el.setAttribute('href', phoneHref);
        }
      })
      .on('[data-phone-href]', {
        element(el) {
          if (el.tagName === 'a') el.setAttribute('href', phoneHref);
        }
      })
      .on('[data-content-email]', {
        element(el) {
          el.setInnerContent(biz.email || '');
          if (el.tagName === 'a' && biz.email) el.setAttribute('href', `mailto:${biz.email}`);
        }
      })
      .on('[data-content-list="contact.hours"]', {
        element(el) { el.setInnerContent(hoursHtml, { html: true }); }
      })
      .on('[data-content-areas-text]', {
        element(el) { el.setInnerContent(areasText); }
      })
      .on('[data-content-areas-list]', {
        element(el) { el.setInnerContent(areasListHtml, { html: true }); }
      })
      .on('#sections-container', {
        element(el) { el.setInnerContent(sectionsHtml, { html: true }); }
      })
      .on('#form-fields-placeholder', {
        element(el) { el.replace(fieldsHtml + (tsHtml ? '\n' + tsHtml : ''), { html: true }); }
      })
      .on('button[type="submit"]', {
        element(el) {
          if (formCfg.submitLabel) el.setInnerContent(formCfg.submitLabel);
        }
      })
      .on('[data-content-footer-services]', {
        element(el) { el.setInnerContent(footerSvcHtml, { html: true }); }
      })
      .on('[data-content-footer-credit]', {
        element(el) {
          if (content.footer && content.footer.creditName) el.setInnerContent(content.footer.creditName);
          if (content.footer && content.footer.creditUrl)  el.setAttribute('href', content.footer.creditUrl);
        }
      })
      .on('[data-content-copyright]', {
        element(el) {
          if (content.footer && content.footer.copyright) el.setInnerContent(content.footer.copyright);
        }
      });

    return rewriter.transform(new Response(modifiedHtml, {
      status: 200,
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    }));

  } catch (e) {
    console.error('renderPage error:', e);
    return env.ASSETS.fetch(new Request(url.href));
  }
}

// ─── Section Renderer ─────────────────────────────────────────────────────────

function renderSection(sec, idx) {
  const isTestimonial = sec.items && sec.items.length > 0 && sec.items[0].quote !== undefined;
  const useAlt  = idx % 2 === 1;
  const idAttr  = sec.id ? ` id="${escAttr(sec.id)}"` : '';

  let headerHtml = '';
  if (sec.label)      headerHtml += `<p class="section__label">${escHtml(sec.label)}</p>`;
  if (sec.heading)    headerHtml += `<h2 class="section-heading">${escHtml(sec.heading)}</h2>`;
  if (sec.subheading) headerHtml += `<p class="section__subheading">${escHtml(sec.subheading)}</p>`;

  let gridHtml = '';
  if (sec.items && sec.items.length > 0) {
    if (isTestimonial) {
      const cards = sec.items.map(item => {
        const stars = Array(item.stars || 5).fill(
          `<svg width="18" height="18" viewBox="0 0 20 20" fill="var(--color-star)" xmlns="http://www.w3.org/2000/svg"><path d="M10 1l2.5 5.5H18l-4.5 3.5 1.5 5.5L10 13l-5 2.5 1.5-5.5L2 6.5h5.5z"/></svg>`
        ).join('');
        return `<div class="testimonial-card">
  <div class="testimonial-card__stars">${stars}</div>
  <blockquote class="testimonial-card__quote">${escHtml(item.quote || '')}</blockquote>
  <div class="testimonial-card__author">
    <strong>${escHtml(item.author || '')}</strong>
    <span>${escHtml(item.role || '')}</span>
  </div>
</div>`;
      }).join('');
      gridHtml = `<div class="testimonials-grid">${cards}</div>`;
    } else {
      const cards = sec.items.map(item => {
        let inner = '';
        if (item.icon)   inner += `<div class="card__icon"><i data-lucide="${escAttr(item.icon)}"></i></div>`;
        if (item.number) inner += `<div class="card__number">${escHtml(String(item.number))}</div>`;
        if (item.title)  inner += `<h3 class="card__title">${escHtml(item.title)}</h3>`;
        if (item.text)   inner += `<p class="card__text">${escHtml(item.text)}</p>`;
        return `<div class="card">${inner}</div>`;
      }).join('');
      gridHtml = `<div class="cards-grid">${cards}</div>`;
    }
  }

  return `<section${idAttr} class="section section-visible${useAlt ? ' section--alt' : ''}">
  <div class="container">
    <div class="section__header">${headerHtml}</div>
    ${gridHtml}
  </div>
</section>`;
}