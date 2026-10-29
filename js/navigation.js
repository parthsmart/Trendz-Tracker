const header = document.querySelector('.header-inner');
const navs = [...document.querySelectorAll('.header-inner .nav-zone')];
if (header && navs.length) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'navigation-toggle btn btn-outline';
  toggle.textContent = 'Menu';
  toggle.setAttribute('aria-expanded', 'false');
  navs.forEach((nav, index) => { nav.id ||= `primary-navigation-${index}`; });
  toggle.setAttribute('aria-controls', navs.map(nav => nav.id).join(' '));
  header.insertBefore(toggle, navs[0]);
  function syncRoles() {
    navs.forEach(nav => { nav.dataset.navigationEnabled = String(nav.style.display !== 'none' && !nav.hidden); });
  }
  syncRoles();
  const observer = new MutationObserver(syncRoles);
  navs.forEach(nav => observer.observe(nav, {attributes:true, attributeFilter:['style','hidden']}));
  const close = () => { header.classList.remove('navigation-open'); toggle.setAttribute('aria-expanded','false'); };
  toggle.addEventListener('click', () => { const open = header.classList.toggle('navigation-open'); toggle.setAttribute('aria-expanded', String(open)); });
  header.addEventListener('keydown', event => { if (event.key === 'Escape' && header.classList.contains('navigation-open')) { close(); toggle.focus(); } });
  navs.forEach(nav => {
    nav.addEventListener('click', event => { if(event.target.closest('a')) close(); });
    nav.querySelectorAll('.nav-link.active').forEach(link => link.setAttribute('aria-current','page'));
  });
  document.addEventListener('click', event => { if(!header.contains(event.target)) close(); });
}
