const OVERLAY_SCROLLBAR_SELECTOR = [
  '.session-list',
  '.chat-scroll',
  '.composer-input',
  '.code-block',
  '.reasoning.open .reasoning-body',
  '.settings-nav',
  '.settings-content',
  '.directory-list',
  '.capability-list',
  '.modal-body'
].join(',');

const MIN_THUMB_SIZE = 32;
const THUMB_INSET = 2;
const THUMB_SIZE = 5;

type Axis = 'vertical' | 'horizontal';

interface AxisState {
  axis: Axis;
  thumb: HTMLDivElement;
}

interface TargetState {
  element: HTMLElement;
  vertical: AxisState;
  horizontal: AxisState;
  resizeObserver: ResizeObserver;
  mutationObserver: MutationObserver;
  update: () => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createThumb(element: HTMLElement, axis: Axis, scheduleUpdate: () => void) {
  const thumb = document.createElement('div');
  thumb.className = `floating-scrollbar-thumb ${axis}`;
  thumb.setAttribute('aria-hidden', 'true');

  thumb.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;

    const rect = element.getBoundingClientRect();
    const maxScroll = axis === 'vertical' ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
    if (maxScroll <= 0) return;

    event.preventDefault();
    thumb.classList.add('dragging');

    const startPointer = axis === 'vertical' ? event.clientY : event.clientX;
    const startScroll = axis === 'vertical' ? element.scrollTop : element.scrollLeft;
    const thumbRect = thumb.getBoundingClientRect();
    const trackLength = axis === 'vertical' ? rect.height : rect.width;
    const thumbLength = axis === 'vertical' ? thumbRect.height : thumbRect.width;
    const maxThumbOffset = Math.max(1, trackLength - thumbLength - THUMB_INSET * 2);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const pointer = axis === 'vertical' ? moveEvent.clientY : moveEvent.clientX;
      const nextScroll = startScroll + ((pointer - startPointer) / maxThumbOffset) * maxScroll;
      if (axis === 'vertical') {
        element.scrollTop = nextScroll;
      } else {
        element.scrollLeft = nextScroll;
      }
      scheduleUpdate();
    };

    const handlePointerUp = () => {
      thumb.classList.remove('dragging');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      scheduleUpdate();
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
  });

  document.body.appendChild(thumb);
  return { axis, thumb };
}

function hideThumb(axisState: AxisState) {
  axisState.thumb.classList.remove('visible');
}

function isTargetOnTop(element: HTMLElement, rect: DOMRect, axis: Axis) {
  const sampleX = axis === 'vertical' ? rect.right - THUMB_SIZE - THUMB_INSET : rect.left + rect.width / 2;
  const sampleY = axis === 'vertical' ? rect.top + rect.height / 2 : rect.bottom - THUMB_SIZE - THUMB_INSET;
  const x = clamp(sampleX, 0, Math.max(0, window.innerWidth - 1));
  const y = clamp(sampleY, 0, Math.max(0, window.innerHeight - 1));
  const topElement = document.elementsFromPoint(x, y).find((item) => !item.classList.contains('floating-scrollbar-thumb'));
  return Boolean(topElement && (topElement === element || element.contains(topElement)));
}

function updateAxis(element: HTMLElement, axisState: AxisState) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    hideThumb(axisState);
    return;
  }

  const vertical = axisState.axis === 'vertical';
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const isInViewport = rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
  if (!isInViewport) {
    hideThumb(axisState);
    return;
  }

  if (!isTargetOnTop(element, rect, axisState.axis)) {
    hideThumb(axisState);
    return;
  }

  const clientLength = vertical ? element.clientHeight : element.clientWidth;
  const scrollLength = vertical ? element.scrollHeight : element.scrollWidth;
  const maxScroll = scrollLength - clientLength;
  if (maxScroll <= 1 || clientLength <= 0) {
    hideThumb(axisState);
    return;
  }

  const trackLength = vertical ? rect.height : rect.width;
  if (trackLength < MIN_THUMB_SIZE) {
    hideThumb(axisState);
    return;
  }

  const thumbLength = clamp((clientLength / scrollLength) * trackLength, MIN_THUMB_SIZE, trackLength - THUMB_INSET * 2);
  const availableTrack = Math.max(1, trackLength - thumbLength - THUMB_INSET * 2);
  const scrollOffset = vertical ? element.scrollTop : element.scrollLeft;
  const thumbOffset = THUMB_INSET + (scrollOffset / maxScroll) * availableTrack;

  const thumb = axisState.thumb;
  if (vertical) {
    thumb.style.width = `${THUMB_SIZE}px`;
    thumb.style.height = `${thumbLength}px`;
    thumb.style.transform = `translate3d(${Math.round(rect.right - THUMB_SIZE - THUMB_INSET)}px, ${Math.round(rect.top + thumbOffset)}px, 0)`;
  } else {
    thumb.style.width = `${thumbLength}px`;
    thumb.style.height = `${THUMB_SIZE}px`;
    thumb.style.transform = `translate3d(${Math.round(rect.left + thumbOffset)}px, ${Math.round(rect.bottom - THUMB_SIZE - THUMB_INSET)}px, 0)`;
  }
  thumb.classList.add('visible');
}

export function installOverlayScrollbars() {
  const states = new Map<HTMLElement, TargetState>();
  let scanFrame = 0;
  let updateFrame = 0;
  let disposed = false;

  const scheduleAllUpdates = () => {
    if (disposed || updateFrame) return;
    updateFrame = window.requestAnimationFrame(() => {
      updateFrame = 0;
      states.forEach((state) => state.update());
    });
  };

  const disposeTarget = (element: HTMLElement) => {
    const state = states.get(element);
    if (!state) return;
    state.resizeObserver.disconnect();
    state.mutationObserver.disconnect();
    state.vertical.thumb.remove();
    state.horizontal.thumb.remove();
    element.classList.remove('overlay-scrollbar-target');
    element.removeEventListener('scroll', state.update);
    states.delete(element);
  };

  const ensureTarget = (element: HTMLElement) => {
    if (states.has(element)) return;

    element.classList.add('overlay-scrollbar-target');
    let targetFrame = 0;
    const update = () => {
      if (disposed || targetFrame) return;
      targetFrame = window.requestAnimationFrame(() => {
        targetFrame = 0;
        if (!element.isConnected) {
          disposeTarget(element);
          return;
        }
        updateAxis(element, state.vertical);
        updateAxis(element, state.horizontal);
      });
    };

    const state: TargetState = {
      element,
      vertical: createThumb(element, 'vertical', update),
      horizontal: createThumb(element, 'horizontal', update),
      resizeObserver: new ResizeObserver(update),
      mutationObserver: new MutationObserver(update),
      update
    };

    states.set(element, state);
    state.resizeObserver.observe(element);
    state.mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });
    element.addEventListener('scroll', update, { passive: true });
    update();
  };

  const scan = () => {
    if (disposed) return;
    document.querySelectorAll<HTMLElement>(OVERLAY_SCROLLBAR_SELECTOR).forEach(ensureTarget);

    states.forEach((_state, element) => {
      if (!element.isConnected || !element.matches(OVERLAY_SCROLLBAR_SELECTOR)) {
        disposeTarget(element);
      }
    });
    scheduleAllUpdates();
  };

  const scheduleScan = () => {
    if (disposed || scanFrame) return;
    scanFrame = window.requestAnimationFrame(() => {
      scanFrame = 0;
      scan();
    });
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', scheduleAllUpdates);
  window.addEventListener('scroll', scheduleAllUpdates, true);
  scan();

  return () => {
    disposed = true;
    observer.disconnect();
    window.removeEventListener('resize', scheduleAllUpdates);
    window.removeEventListener('scroll', scheduleAllUpdates, true);
    if (scanFrame) window.cancelAnimationFrame(scanFrame);
    if (updateFrame) window.cancelAnimationFrame(updateFrame);
    Array.from(states.keys()).forEach(disposeTarget);
  };
}
