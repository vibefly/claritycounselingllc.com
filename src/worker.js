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

  if (env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
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
    const contentRes = await env.ASSETS.fetch(new Request(new URL('/content.json', url).href));
    if (!contentRes.ok) return new Response('Not found', { status: 404 });

    const content = await contentRes.json();

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

    const titleText   = (content.meta && content.meta.title)       || biz.name || '';
    const description = (content.meta && content.meta.description) || '';
    const canonical   = url.origin + url.pathname;

    // ── Build content fragments ─────────────────────────────────────────────

    const navHtml = nav.map(item =>
      `<li><a class="nav-link" href="${escAttr(item.href || '#')}">${escHtml(item.label || '')}</a></li>`
    ).join('');

    const sectionsHtml = sections.map((sec, idx) => renderSection(sec, idx)).join('\n');

    const serviceAreas   = (content.contact && content.contact.serviceAreas) || [];
    const areasText      = serviceAreas.join(', ');

    const hours     = (content.contact && content.contact.hours) || [];
    const hoursHtml = hours.map(h => `<p class="hours-line">${escHtml(h)}</p>`).join('');

    const footerSvc = sections.find(s => s.items && s.items.length > 0 && !s.items[0].quote);
    const footerSvcHtml = footerSvc ? footerSvc.items.map(item =>
      `<li><a href="#${escAttr(footerSvc.id || 'services')}">${escHtml(item.title || '')}</a></li>`
    ).join('') : '';

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
          inputHtml = `<select id="${id}" name="${escAttr(field.name)}"${req}><option value="">${escHtml(field.placeholder || 'Select\u2026')}</option>${opts}</select>`;
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

    // Theme CSS variables
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

    const ogTags = [
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${escAttr(canonical)}">`,
      `<meta property="og:title" content="${escAttr(titleText)}">`,
      `<meta property="og:description" content="${escAttr(description)}">`,
    ].join('\n');

    const inlineScripts = `<script>window.__BUSINESS=${JSON.stringify(biz)};window.__FORM_CONFIG=${JSON.stringify(formCfg)};window.__IMAGES=[];</script>`;

    const logo    = content.logo    || {};
    const hero    = content.hero    || {};
    const contact = content.contact || {};
    const footer  = content.footer  || {};

    const submitLabel = escHtml(formCfg.submitLabel || 'Send Message');
    const ctaHref     = escAttr(hero.ctaHref || '#contact');
    const ctaText     = escHtml(hero.ctaText || 'Book a Session');
    const ctaSecText  = escHtml(hero.ctaSecondaryText || 'Learn More');
    const ctaSecHref  = escAttr(hero.ctaSecondaryHref || '#about');

    // ── Build complete HTML ───────────────────────────────────────────────────

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(titleText)}</title>
  <meta name="description" content="${escAttr(description)}">
  ${ogTags}
  <link rel="stylesheet" href="/styles.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  ${themeStyle}
  ${inlineScripts}
  <script src="/js/lucide.min.js" defer onload="lucide.createIcons()"></script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>

  <header class="site-header" id="top">
    <div class="container header-inner">
      <a class="logo" href="/">
        <span class="logo-name">${escHtml(logo.name || biz.name || '')}</span><span class="logo-tld">${escHtml(logo.tld || '')}</span>
      </a>
      <nav class="main-nav" aria-label="Main navigation">
        <ul>${navHtml}</ul>
      </nav>
      <a class="btn btn--primary header-cta" href="${ctaHref}">${ctaText}</a>
      <button class="nav-toggle" aria-label="Open menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>
  </header>

  <div class="mobile-drawer" id="mobile-drawer" aria-hidden="true">
    <div class="mobile-drawer__inner">
      <button class="mobile-drawer__close" aria-label="Close menu">&times;</button>
      <nav>
        <ul class="mobile-nav-list">${navHtml}</ul>
      </nav>
      <div class="mobile-drawer__cta">
        <a class="btn btn--primary" href="${ctaHref}">${ctaText}</a>
      </div>
    </div>
  </div>
  <div class="mobile-drawer__overlay" id="drawer-overlay"></div>

  <main>

    <section class="hero" id="home">
      <div class="hero__bg-shapes">
        <div class="shape shape--1"></div>
        <div class="shape shape--2"></div>
        <div class="shape shape--3"></div>
      </div>
      <div class="container hero__inner">
        <div class="hero__content">
          <p class="hero__label">${escHtml(hero.label || '')}</p>
          <h1 class="hero__title">${escHtml(hero.title || '')}</h1>
          <p class="hero__subtext">${escHtml(hero.subtext || '')}</p>
          <div class="hero__actions">
            <a class="btn btn--primary" href="${ctaHref}">${ctaText}</a>
            <a class="btn btn--ghost" href="${ctaSecHref}">${ctaSecText}</a>
          </div>
        </div>
        <div class="hero__visual">
          <div class="hero__image-frame">
            <div class="hero__image-placeholder">
              <i data-lucide="heart-pulse" width="64" height="64"></i>
            </div>
          </div>
          <div class="hero__badge hero__badge--1">
            <i data-lucide="shield-check" width="18" height="18"></i>
            <span>Licensed &amp; Certified</span>
          </div>
          <div class="hero__badge hero__badge--2">
            <i data-lucide="calendar" width="18" height="18"></i>
            <span>Online &amp; In-Person</span>
          </div>
        </div>
      </div>
    </section>

    <section class="trust-bar">
      <div class="container trust-bar__inner">
        <div class="trust-item">
          <i data-lucide="award" width="22" height="22"></i>
          <span>Board Certified</span>
        </div>
        <div class="trust-divider"></div>
        <div class="trust-item">
          <i data-lucide="users" width="22" height="22"></i>
          <span>500+ Clients Helped</span>
        </div>
        <div class="trust-divider"></div>
        <div class="trust-item">
          <i data-lucide="clock" width="22" height="22"></i>
          <span>10+ Years Experience</span>
        </div>
        <div class="trust-divider"></div>
        <div class="trust-item">
          <i data-lucide="lock" width="22" height="22"></i>
          <span>Fully Confidential</span>
        </div>
      </div>
    </section>

    <div id="sections-container">${sectionsHtml}</div>

    <section class="contact-section" id="contact">
      <div class="container">
        <div class="contact-grid">

          <div class="contact-info">
            <p class="section__label">${escHtml(contact.heading || 'Get In Touch')}</p>
            <h2 class="section-heading contact-info__heading">${escHtml(contact.subheading || '')}</h2>
            <p class="contact-info__body">Reaching out is the first and bravest step. Fill in the form and I'll be in touch within one business day to schedule your free 15-minute consultation.</p>

            <ul class="contact-details">
              <li>
                <span class="contact-icon"><i data-lucide="phone" width="18" height="18"></i></span>
                <a href="${escAttr(phoneHref)}" class="contact-link">${escHtml(phone)}</a>
              </li>
              <li>
                <span class="contact-icon"><i data-lucide="mail" width="18" height="18"></i></span>
                <a href="${biz.email ? `mailto:${escAttr(biz.email)}` : '#'}" class="contact-link">${escHtml(biz.email || '')}</a>
              </li>
              <li>
                <span class="contact-icon"><i data-lucide="map-pin" width="18" height="18"></i></span>
                <span>${escHtml(biz.address || '')}</span>
              </li>
            </ul>

            <div class="contact-hours">${hoursHtml}</div>

            <div class="contact-areas">
              <p class="contact-areas__label">Serving:</p>
              <p>${escHtml(areasText)}</p>
            </div>
          </div>

          <div class="contact-form-wrap">
            <div class="form-card">
              <div id="form-success" class="form-success" hidden>
                <div class="form-success__icon"><i data-lucide="check-circle" width="48" height="48"></i></div>
                <h3 class="form-success__heading">${escHtml(formCfg.thankYouHeading || 'Message Sent')}</h3>
                <p class="form-success__message">${escHtml(formCfg.thankYouMessage || 'Thank you for reaching out.')}</p>
                <p class="form-success__sub">${escHtml(formCfg.thankYouSubtext || '')}</p>
              </div>
              <form id="contact-form" class="contact-form" novalidate>
                ${fieldsHtml}
                ${tsHtml}
                <button type="submit" class="btn btn--primary btn--full">${submitLabel}</button>
                <p class="form-note" id="form-status"></p>
              </form>
            </div>
          </div>

        </div>
      </div>
    </section>

  </main>

  <footer class="site-footer">
    <div class="container footer-inner">
      <div class="footer-brand">
        <a class="logo logo--footer" href="/">
          <span class="logo-name">${escHtml(logo.name || biz.name || '')}</span><span class="logo-tld">${escHtml(logo.tld || '')}</span>
        </a>
        <p class="footer-about">${escHtml(footer.about || '')}</p>
      </div>
      <div class="footer-nav">
        <p class="footer-nav__label">Navigation</p>
        <ul class="footer-nav__list">${navHtml}</ul>
      </div>
      <div class="footer-services">
        <p class="footer-nav__label">Services</p>
        <ul>${footerSvcHtml}</ul>
      </div>
      <div class="footer-contact">
        <p class="footer-nav__label">Contact</p>
        <a href="${escAttr(phoneHref)}" class="footer-contact__link">${escHtml(phone)}</a>
        <a href="${biz.email ? `mailto:${escAttr(biz.email)}` : '#'}" class="footer-contact__link">${escHtml(biz.email || '')}</a>
      </div>
    </div>
    <div class="footer-bottom">
      <div class="container">
        <p>${escHtml(footer.copyright || '')}</p>
        <p class="footer-disclaimer">This website is for informational purposes only and does not constitute medical advice.</p>
      </div>
    </div>
  </footer>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      if (window.lucide) lucide.createIcons();
    });
    window.addEventListener('load', () => {
      if (window.lucide) lucide.createIcons();
    });

    const toggle = document.querySelector('.nav-toggle');
    const drawer = document.getElementById('mobile-drawer');
    const overlay = document.getElementById('drawer-overlay');
    const closeBtn = document.querySelector('.mobile-drawer__close');

    function openDrawer() {
      drawer.removeAttribute('aria-hidden');
      document.body.classList.add('drawer-open');
      toggle.setAttribute('aria-expanded', 'true');
    }
    function closeDrawer() {
      drawer.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('drawer-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
    toggle && toggle.addEventListener('click', openDrawer);
    closeBtn && closeBtn.addEventListener('click', closeDrawer);
    overlay && overlay.addEventListener('click', closeDrawer);
    drawer && drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));

    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function(e) {
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
          e.preventDefault();
          const top = target.getBoundingClientRect().top + window.scrollY - 80;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      });
    });

    const header = document.querySelector('.site-header');
    window.addEventListener('scroll', () => {
      header.classList.toggle('scrolled', window.scrollY > 20);
    }, { passive: true });

    const form = document.getElementById('contact-form');
    const formSuccess = document.getElementById('form-success');
    const formStatus = document.getElementById('form-status');

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Sending\u2026';
        formStatus.textContent = '';

        const cfg = window.__FORM_CONFIG || {};

        try {
          const data = Object.fromEntries(new FormData(form));
          const res = await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          const json = await res.json();
          if (json.ok) {
            form.hidden = true;
            formSuccess.hidden = false;
            if (window.lucide) lucide.createIcons();
          } else {
            formStatus.textContent = cfg.errorMessage || json.error || 'Something went wrong. Please try again.';
            btn.disabled = false;
            btn.textContent = cfg.submitLabel || 'Send Message';
          }
        } catch {
          formStatus.textContent = cfg.errorMessage || 'Network error. Please try again.';
          btn.disabled = false;
          btn.textContent = cfg.submitLabel || 'Send Message';
        }
      });
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll('.section, .contact-section, .trust-bar').forEach(el => io.observe(el));
  </script>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    });

  } catch (e) {
    console.error('renderPage error:', e);
    return new Response('Internal server error', { status: 500 });
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
