/* GSAP 3.15.0: progressive motion; all content is readable without these scripts. */
(() => {
  if (!window.gsap || !window.ScrollTrigger) return;
  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);
  const media = gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)', context => {
    const progress = document.createElement('div');
    progress.className = 'reading-progress';
    progress.setAttribute('aria-hidden', 'true');
    document.body.append(progress);
    gsap.to(progress, { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: true } });
    gsap.from('.hero-copy > *', { y: 24, opacity: 0, duration: .9, stagger: .12, ease: 'power3.out' });
    gsap.from('.hero-art', { opacity: 0, duration: 1.2, delay: .25 });
    gsap.from('.hero-art .note-a, .hero-art .note-b', { y: 22, opacity: 0, duration: .8, stagger: .18, delay: .6 });
    document.querySelectorAll('.reveal').forEach(element => {
      gsap.from(element, { y: 28, opacity: 0, duration: .8, ease: 'power2.out', scrollTrigger: { trigger: element, start: 'top 94%', once: true } });
    });
    gsap.from('.manifesto h2', { x: -10, ease: 'none', scrollTrigger: { trigger: '.manifesto h2', start: 'top 85%', end: 'bottom 55%', scrub: .5 } });
    gsap.fromTo('.life > img', { scale: 1.1 }, { scale: 1, ease: 'none', scrollTrigger: { trigger: '.life', start: 'top bottom', end: 'bottom top', scrub: .6 } });
    document.querySelectorAll('.innovation-scene').forEach(scene => {
      gsap.from(scene.children, { y: 15, opacity: 0, stagger: .2, duration: .6, scrollTrigger: { trigger: scene, start: 'top 90%', once: true } });
    });
    let conversationTween;
    context.add('changeConversation', () => {
      conversationTween?.revert();
      conversationTween = gsap.from('#bubbles > *', { y: 12, opacity: 0, duration: .4, stagger: .1, ease: 'power2.out' });
    });
    let filmTween;
    context.add('openFilm', () => {
      filmTween?.revert();
      filmTween = gsap.from('#film', { y: 18, opacity: 0, duration: .3, ease: 'power2.out' });
    });
    const refresh = () => ScrollTrigger.refresh();
    document.addEventListener('conversation-change', context.changeConversation);
    document.addEventListener('film-open', context.openFilm);
    document.querySelectorAll('details').forEach(item => item.addEventListener('toggle', refresh));
    window.addEventListener('load', refresh);
    let active = true;
    document.fonts?.ready.then(() => { if (active) refresh(); });
    return () => {
      active = false;
      progress.remove();
      document.removeEventListener('conversation-change', context.changeConversation);
      document.removeEventListener('film-open', context.openFilm);
      document.querySelectorAll('details').forEach(item => item.removeEventListener('toggle', refresh));
      window.removeEventListener('load', refresh);
    };
  });
  media.add('(prefers-reduced-motion: no-preference) and (min-width: 900px) and (hover: hover) and (pointer: fine)', () => {
    gsap.to('.hero-art img', { y: 65, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: .7 } });
    const cleanups = [];
    document.querySelectorAll('.innovation-scene').forEach(scene => {
      const x = gsap.quickTo(scene, 'x', { duration: .6, ease: 'power3.out' });
      const y = gsap.quickTo(scene, 'y', { duration: .6, ease: 'power3.out' });
      const card = scene.closest('.innovation');
      const move = event => { const rect = card.getBoundingClientRect(); x((event.clientX - rect.left - rect.width / 2) * .025); y((event.clientY - rect.top - rect.height / 2) * .025); };
      const reset = () => { x(0); y(0); };
      card.addEventListener('pointermove', move);
      card.addEventListener('pointerleave', reset);
      cleanups.push(() => { card.removeEventListener('pointermove', move); card.removeEventListener('pointerleave', reset); });
    });
    return () => cleanups.forEach(cleanup => cleanup());
  });
})();
