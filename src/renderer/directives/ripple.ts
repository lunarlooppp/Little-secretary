import type { Directive } from 'vue';

type RippleElement = HTMLElement & {
  __littleSecretaryRipple?: (event: PointerEvent) => void;
};

function createRipple(event: PointerEvent, element: HTMLElement) {
  if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return;

  const rect = element.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.15;
  const ripple = document.createElement('span');
  const x = event.clientX - rect.left - size / 2;
  const y = event.clientY - rect.top - size / 2;

  ripple.className = 'tap-ripple';
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;

  element.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
}

export const rippleDirective: Directive<RippleElement> = {
  mounted(element) {
    element.classList.add('tap-ripple-host');
    element.__littleSecretaryRipple = (event: PointerEvent) => createRipple(event, element);
    element.addEventListener('pointerdown', element.__littleSecretaryRipple, { passive: true });
  },
  unmounted(element) {
    if (!element.__littleSecretaryRipple) return;
    element.removeEventListener('pointerdown', element.__littleSecretaryRipple);
    delete element.__littleSecretaryRipple;
  }
};
