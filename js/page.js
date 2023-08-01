(function () {
  'use strict';

  const domReady = new Promise((resolve) => {
    function checkState() {
      if (document.readyState !== 'loading') resolve();
    }

    document.addEventListener('readystatechange', checkState);
    checkState();
  });

  const range = document.createRange();
  range.selectNode(document.documentElement);

  function strToEl(str) {
    return range.createContextualFragment(String(str)).children[0];
  }

  const entityMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;',
  };

  function escapeHTML(str) {
    return String(str).replace(/[&<>"'/]/g, (s) => entityMap[s]);
  }

  function escapeHtmlTag(strings, ...values) {
    values = values.map((s) => escapeHTML(s));
    return strings.reduce((str, val, i) => str + val + (values[i] || ''), '');
  }

  function readFileAsText(file) {
    return new Response(file).text();
  }

  function transitionClassFunc({ removeClass = false } = {}) {
    return (element, className = 'active', transitionClass = 'transition') => {
      const hasClass = element.classList.contains(className);

      if (removeClass) {
        if (!hasClass) return Promise.resolve();
      } else if (hasClass) {
        return Promise.resolve();
      }

      const transitionEnd = new Promise((resolve) => {
        const listener = (event) => {
          if (event.target !== element) return;
          element.removeEventListener('transitionend', listener);
          element.classList.remove(transitionClass);
          resolve();
        };

        element.classList.add(transitionClass);

        requestAnimationFrame(() => {
          element.addEventListener('transitionend', listener);
          element.classList[removeClass ? 'remove' : 'add'](className);
        });
      });

      const transitionTimeout = new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });

      return Promise.race([transitionEnd, transitionTimeout]);
    };
  }

  const transitionToClass = transitionClassFunc();
  const transitionFromClass = transitionClassFunc({ removeClass: true });

  function trackFocusMethod() {
    let focusMethod = 'mouse';

    document.body.addEventListener(
      'focus',
      (event) => {
        event.target.classList.add(
          focusMethod === 'key' ? 'key-focused' : 'mouse-focused',
        );
      },
      true,
    );

    document.body.addEventListener(
      'blur',
      (event) => {
        event.target.classList.remove('key-focused', 'mouse-focused');
      },
      true,
    );

    document.body.addEventListener(
      'keydown',
      () => {
        focusMethod = 'key';
      },
      true,
    );

    document.body.addEventListener(
      'mousedown',
      () => {
        focusMethod = 'mouse';
      },
      true,
    );
  }

  const idbKeyval = (() => {
    let dbInstance;

    function getDB() {
      if (dbInstance) return dbInstance;

      dbInstance = new Promise((resolve, reject) => {
        const openreq = indexedDB.open('svgo-keyval', 1);

        openreq.onerror = () => {
          reject(openreq.error);
        };

        openreq.onupgradeneeded = () => {
          // First time setup: create an empty object store
          openreq.result.createObjectStore('keyval');
        };

        openreq.onsuccess = () => {
          resolve(openreq.result);
        };
      });

      return dbInstance;
    }

    async function withStore(type, callback) {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('keyval', type);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        callback(transaction.objectStore('keyval'));
      });
    }

    return {
      async get(key) {
        let request;
        await withStore('readonly', (store) => {
          request = store.get(key);
        });
        return request.result;
      },
      set(key, value) {
        return withStore('readwrite', (store) => {
          store.put(value, key);
        });
      },
      delete(key) {
        return withStore('readwrite', (store) => {
          store.delete(key);
        });
      },
    };
  })();

  class WorkerMessenger {
    constructor(url) {
      this._requestId = 0;
      // worker jobs awaiting response { [requestId]: [ resolve, reject ] }
      this._pending = {};
      this._url = url;
      this._worker = null;
    }

    release() {
      this._abortPending();
      if (this._worker) {
        this._worker.terminate();
        this._worker = null;
      }
    }

    requestResponse(message) {
      return new Promise((resolve, reject) => {
        message.id = ++this._requestId;
        this._pending[message.id] = [resolve, reject];

        if (!this._worker) this._startWorker();
        this._worker.postMessage(message);
      });
    }

    abort() {
      if (Object.keys(this._pending).length === 0) return;

      this._abortPending();
      if (this._worker) this._worker.terminate();
      this._startWorker();
    }

    _abortPending() {
      for (const key of Object.keys(this._pending)) {
        this._fulfillPending(
          key,
          null,
          new DOMException('AbortError', 'AbortError'),
        );
      }
    }

    _startWorker() {
      this._worker = new Worker(this._url);
      this._worker.onmessage = (event) => this._onMessage(event);
    }

    _onMessage(event) {
      if (!event.data.id) {
        console.log('Unexpected message', event);
        return;
      }

      this._fulfillPending(
        event.data.id,
        event.data.result,
        event.data.error && new Error(event.data.error),
      );
    }

    _fulfillPending(id, result, error) {
      const resolver = this._pending[id];

      if (!resolver) {
        console.log('No resolver for', { id, result, error });
        return;
      }

      delete this._pending[id];

      if (error) {
        resolver[1](error);
        return;
      }

      resolver[0](result);
    }
  }

  class Gzip extends WorkerMessenger {
    constructor() {
      super('js/gzip-worker.js');
    }

    compress(data) {
      return this.requestResponse({ data });
    }
  }

  const gzip = new Gzip();

  class SvgFile {
    constructor(text, width, height) {
      this.text = text;
      this._compressedSize = null;
      this._url = null;
      this.width = width;
      this.height = height;
    }

    async size({ compress }) {
      if (!compress) return this.text.length;

      if (!this._compressedSize) {
        this._compressedSize = gzip
          .compress(this.text)
          .then((response) => response.byteLength);
      }

      return this._compressedSize;
    }

    get url() {
      if (!this._url) {
        this._url = URL.createObjectURL(
          new Blob([this.text], { type: 'image/svg+xml' }),
        );
      }

      return this._url;
    }

    release() {
      if (!this._url) return;

      URL.revokeObjectURL(this._url);
    }
  }

  class Svgo extends WorkerMessenger {
    constructor() {
      super('js/svgo-worker.js');
      this._currentJob = Promise.resolve();
    }

    async wrapOriginal(svgText) {
      const { width, height } = await this.requestResponse({
        action: 'wrapOriginal',
        data: svgText,
      });

      return new SvgFile(svgText, width, height);
    }

    process(svgText, settings) {
      this.abort();

      this._currentJob = this._currentJob
        .catch(() => {})
        .then(async () => {
          const { data, dimensions } = await this.requestResponse({
            action: 'process',
            settings,
            data: svgText,
          });

          // return final result
          return new SvgFile(data, dimensions.width, dimensions.height);
        });

      return this._currentJob;
    }
  }

  function getXY(obj) {
    return {
      x: obj.pageX,
      y: obj.pageY,
    };
  }

  function touchDistance(touch1, touch2) {
    const dx = Math.abs(touch2.x - touch1.x);
    const dy = Math.abs(touch2.y - touch1.y);
    return Math.hypot(dx, dy);
  }

  function getMidpoint(point1, point2) {
    return {
      x: (point1.x + point2.x) / 2,
      y: (point1.y + point2.y) / 2,
    };
  }

  function getPoints(event) {
    return event.touches
      ? [...event.touches].map((touch) => getXY(touch))
      : [getXY(event)];
  }

  class PanZoom {
    constructor(
      target,
      { eventArea = target, shouldCaptureFunc = () => true } = {},
    ) {
      this._target = target;
      this._shouldCaptureFunc = shouldCaptureFunc;
      this._dx = 0;
      this._dy = 0;
      this._scale = 1;
      this._active = 0;
      this._lastPoints = [];

      // TODO: revisit this later
      // Ideally these would use public class fields, but around 1.7% of users
      // are on old Safari versions that don't support them. We should be able
      // to switch over soon.
      this._onPointerDown = (event) => {
        if (event.type === 'mousedown' && event.button !== 0) return;
        if (!this._shouldCaptureFunc(event.target)) return;
        event.preventDefault();

        this._lastPoints = getPoints(event);
        this._active++;

        if (this._active === 1) this._onFirstPointerDown();
      };

      this._onPointerMove = (event) => {
        event.preventDefault();
        const points = getPoints(event);
        /* eslint-disable unicorn/no-array-reduce, unicorn/no-array-callback-reference */
        const averagePoint = points.reduce(getMidpoint);
        const averageLastPoint = this._lastPoints.reduce(getMidpoint);
        /* eslint-enable unicorn/no-array-reduce, unicorn/no-array-callback-reference */
        const { left, top } = this._target.getBoundingClientRect();

        this._dx += averagePoint.x - averageLastPoint.x;
        this._dy += averagePoint.y - averageLastPoint.y;

        if (points[1]) {
          const scaleDiff =
            touchDistance(points[0], points[1]) /
            touchDistance(this._lastPoints[0], this._lastPoints[1]);
          this._scale *= scaleDiff;
          this._dx -= (averagePoint.x - left) * (scaleDiff - 1);
          this._dy -= (averagePoint.y - top) * (scaleDiff - 1);
        }

        this._update();
        this._lastPoints = points;
      };

      this._onPointerUp = (event) => {
        event.preventDefault();
        this._active--;
        this._lastPoints.pop();

        if (this._active) {
          this._lastPoints = getPoints(event);
          return;
        }

        document.removeEventListener('mousemove', this._onPointerMove);
        document.removeEventListener('mouseup', this._onPointerUp);
        document.removeEventListener('touchmove', this._onPointerMove);
        document.removeEventListener('touchend', this._onPointerUp);
      };

      // bound events
      eventArea.addEventListener('mousedown', this._onPointerDown);
      eventArea.addEventListener('touchstart', this._onPointerDown);

      // unbound
      eventArea.addEventListener('wheel', (event) => this._onWheel(event));
    }

    reset() {
      this._dx = 0;
      this._dy = 0;
      this._scale = 1;
      this._update();
    }

    _onWheel(event) {
      if (!this._shouldCaptureFunc(event.target)) return;
      event.preventDefault();

      const { left, top } = this._target.getBoundingClientRect();
      let delta = event.deltaY;

      // 1 is "lines", 0 is "pixels"
      // Firefox uses "lines" when mouse is connected
      if (event.deltaMode === 1) {
        delta *= 15;
      }

      // stop mouse wheel producing huge values
      delta = Math.max(Math.min(delta, 60), -60);

      const scaleDiff = delta / 300 + 1;

      // avoid to-small values
      if (this._scale * scaleDiff < 0.05) return;

      this._scale *= scaleDiff;
      this._dx -= (event.pageX - left) * (scaleDiff - 1);
      this._dy -= (event.pageY - top) * (scaleDiff - 1);
      this._update();
    }

    _onFirstPointerDown() {
      document.addEventListener('mousemove', this._onPointerMove);
      document.addEventListener('mouseup', this._onPointerUp);
      document.addEventListener('touchmove', this._onPointerMove);
      document.addEventListener('touchend', this._onPointerUp);
    }

    _update() {
      this._target.style.transform = `translate3d(${this._dx}px, ${this._dy}px, 0) scale(${this._scale})`;
    }
  }

  class SvgOutput {
    constructor() {
      // prettier-ignore
      this.container = strToEl(
        '<div class="svg-output">' +
          '<div class="svg-container">' +
            '<iframe class="svg-frame" sandbox="allow-scripts" scrolling="no" title="Loaded SVG file"></iframe>' +
          '</div>' +
        '</div>'
      );

      this._svgFrame = this.container.querySelector('.svg-frame');
      this._svgContainer = this.container.querySelector('.svg-container');

      domReady.then(() => {
        this._panZoom = new PanZoom(this._svgContainer, {
          eventArea: this.container,
        });
      });
    }

    setSvg({ text, width, height }) {
      // TODO: revisit this
      // I would rather use blob urls, but they don't work in Firefox
      // All the internal refs break.
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1125667
      const nextLoad = this._nextLoadPromise();
      this._svgFrame.src = `data:image/svg+xml,${encodeURIComponent(text)}`;
      this._svgFrame.style.width = `${width}px`;
      this._svgFrame.style.height = `${height}px`;
      return nextLoad;
    }

    reset() {
      this._svgFrame.src = 'about:blank';
      this._panZoom.reset();
    }

    _nextLoadPromise() {
      return new Promise((resolve) => {
        const onload = () => {
          this._svgFrame.removeEventListener('load', onload);
          resolve();
        };

        this._svgFrame.addEventListener('load', onload);
      });
    }
  }

  class Prism extends WorkerMessenger {
    constructor() {
      super('js/prism-worker.js');
    }

    highlight(data) {
      return this.requestResponse({ data });
    }
  }

  const prism = new Prism();

  class CodeOutput {
    constructor() {
      // prettier-ignore
      this.container = strToEl(
        '<div class="code-output">' +
          '<pre><code></code></pre>' +
        '</div>'
      );
      this._codeEl = this.container.querySelector('code');
    }

    async setSvg({ text }) {
      this._codeEl.innerHTML = await prism.highlight(text);
    }

    reset() {
      this._codeEl.innerHTML = '';
    }
  }

  class Output {
    constructor() {
      this.container = strToEl('<div class="output-switcher"></div>');

      this._types = {
        image: new SvgOutput(),
        code: new CodeOutput(),
      };

      this._svgFile = null;
      this._switchQueue = Promise.resolve();
      this.set('image', { noAnimate: true });
    }

    update(svgFile) {
      this._svgFile = svgFile;
      return this._types[this._activeType].setSvg(svgFile);
    }

    reset() {
      this._types[this._activeType].reset();
    }

    set(type, { noAnimate = false } = {}) {
      this._switchQueue = this._switchQueue.then(async () => {
        const toRemove =
          this._activeType && this._types[this._activeType].container;

        this._activeType = type;
        const toAdd = this._types[this._activeType].container;
        this.container.append(toAdd);

        if (this._svgFile) await this.update(this._svgFile);

        if (noAnimate) {
          toAdd.classList.add('active');
          if (toRemove) toRemove.classList.remove('active');
        } else {
          const transitions = [transitionToClass(toAdd)];

          if (toRemove) transitions.push(transitionFromClass(toRemove));

          await Promise.all(transitions);
        }

        if (toRemove) toRemove.remove();
      });

      return this._switchQueue;
    }
  }

  class Ripple {
    constructor() {
      this.container = strToEl('<span class="ripple"></span>');
    }

    animate() {
      this.container.classList.remove('animate');
      this.container.offsetLeft; // eslint-disable-line no-unused-expressions
      this.container.classList.add('animate');
    }
  }

  class FloatingActionButton {
    constructor({ title, href, iconSvg, major = false }) {
      // prettier-ignore
      this.container = strToEl(
        (href ? '<a>' : '<button class="unbutton" type="button">') +
          iconSvg +
        (href ? '</a>' : '</button>')
      );

      const classes = ['floating-action-button'];

      if (href) this.container.href = href;
      if (title) this.container.setAttribute('title', title);
      if (major) classes.push('major-floating-action-button');

      this.container.classList.add(...classes);

      this._ripple = new Ripple();
      this.container.append(this._ripple.container);
      this.container.addEventListener('click', () => this.onClick());
    }

    onClick() {
      this._ripple.animate();
    }
  }

  class Spinner {
    constructor() {
      // prettier-ignore
      this.container = strToEl(
        '<div class="spinner">' +
          '<div class="spinner-container">' +
            '<div class="spinner-layer">' +
              '<div class="circle-clipper left">' +
                '<div class="circle"></div>' +
              '</div>' +
              '<div class="gap-patch">' +
                '<div class="circle"></div>' +
              '</div>' +
              '<div class="circle-clipper right">' +
                '<div class="circle"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );

      this._showTimeout = null;
      this.container.style.display = 'none';

      this.container.addEventListener('animationend', (event) => {
        if (event.target === this.container) {
          this.container.style.display = 'none';
        }
      });
    }

    show(delay = 300) {
      clearTimeout(this._showTimeout);
      this.container.style.display = 'none';
      this.container.classList.remove('cooldown');
      this._showTimeout = setTimeout(() => {
        this.container.style.display = '';
      }, delay);
    }

    hide() {
      clearTimeout(this._showTimeout);
      this.container.classList.add('cooldown');
    }
  }

  class DownloadButton extends FloatingActionButton {
    constructor() {
      const title = 'Download';

      super({
        title,
        href: './',
        iconSvg:
          // prettier-ignore
          '<svg aria-hidden="true" class="icon" viewBox="0 0 24 24">' +
            '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>' +
          '</svg>',
        major: true,
      });

      this._spinner = new Spinner();
      this.container.append(this._spinner.container);
    }

    setDownload(filename, { url }) {
      this.container.download = filename;
      this.container.href = url;
    }

    working() {
      this._spinner.show(500);
    }

    done() {
      this._spinner.hide();
    }
  }

  class CopyButton extends FloatingActionButton {
    constructor() {
      const title = 'Copy as text';

      super({
        title,
        iconSvg:
          // prettier-ignore
          '<svg aria-hidden="true" class="icon" viewBox="0 0 24 24">' +
            '<path d="M16 1H4C3 1 2 2 2 3v14h2V3h12V1zm3 4H8C7 5 6 6 6 7v14c0 1 1 2 2 2h11c1 0 2-1 2-2V7c0-1-1-2-2-2zm0 16H8V7h11v14z"/>' +
          '</svg>',
      });

      this._text = null;
      this._pre = document.createElement('pre');
    }

    onClick(event) {
      super.onClick(event);
      this.copyText();
    }

    copyText() {
      if (!this._text) return false;

      this._pre.textContent = this._text;
      document.body.append(this._pre);
      getSelection().removeAllRanges();

      const range = document.createRange();
      range.selectNode(this._pre);

      window.getSelection().addRange(range);

      document.execCommand('copy');
      getSelection().removeAllRanges();
      this._pre.remove();

      return true;
    }

    setCopyText(text) {
      this._text = text;
    }
  }

  class BgFillButton extends FloatingActionButton {
    constructor() {
      const title = 'Preview on vivid background';

      super({
        title,
        iconSvg:
          // prettier-ignore
          '<svg aria-hidden="true" class="icon" viewBox="0 0 24 24">' +
            '<path fill="currentColor" d="M21.143 9.667c-.733-1.392-1.914-3.05-3.617-4.753C14.549 1.936 12.048 1 10.741 1c-.414 0-.708.094-.86.246L8.52 2.606c-1.899-.236-3.42.106-4.294.983-.876.875-1.164 2.159-.792 3.523.492 1.806 2.305 4.049 5.905 5.375.038.323.157.638.405.885.588.588 1.535.586 2.121 0s.588-1.533.002-2.119a1.5 1.5 0 0 0-2.123-.001l-.17.256c-2.031-.765-3.395-1.828-4.232-2.9l3.879-3.875c.496 2.73 6.432 8.676 9.178 9.178l-7.115 7.107c-.234.153-2.798-.316-6.156-3.675-3.393-3.393-3.175-5.271-3.027-5.498L3.96 9.989C3.521 9.63 3.035 8.886 2.819 8.3L.685 10.431C.24 10.877 0 11.495 0 12.251c0 1.634 1.121 3.915 3.713 6.506C6.477 21.521 9.293 23 11.145 23c.648 0 1.18-.195 1.547-.562l8.086-8.078c.91.874-.778 3.538-.778 4.648a2 2 0 0 0 4-.001c0-3.184-1.425-6.81-2.857-9.34zM4.934 4.296c.527-.53 1.471-.791 2.656-.761L4.381 6.741c-.236-.978-.049-1.845.553-2.445zm9.292 4.079-.03-.029C12.904 7.054 10.393 3.99 11.1 3.283c.715-.715 3.488 1.521 5.062 3.096.862.862 2.088 2.247 2.937 3.458-1.717-1.074-3.491-1.469-4.873-1.462z"/>' +
          '</svg>',
      });
    }

    onClick(event) {
      super.onClick(event);

      if (this.container.classList.contains('active')) {
        this.container.classList.remove('active');
        document.documentElement.classList.remove('bg-dark');
      } else {
        this.container.classList.add('active');
        document.documentElement.classList.add('bg-dark');
      }
    }
  }

  function round(num, places) {
    const mult = 10 ** places;
    return Math.floor(Math.round(num * mult)) / mult;
  }

  function humanSize(bytes) {
    return bytes < 1024 ? `${bytes} bytes` : `${round(bytes / 1024, 2)}k`;
  }

  class Results {
    constructor() {
      // prettier-ignore
      this.container = strToEl(
        '<div class="results">' +
          '<span class="size"></span> ' +
          '<span class="diff"></span>' +
        '</div>'
      );

      this._sizeEl = this.container.querySelector('.size');
      this._diffEl = this.container.querySelector('.diff');
    }

    update({ size, comparisonSize }) {
      this._sizeEl.textContent = comparisonSize
        ? `${humanSize(comparisonSize)} → ${humanSize(size)}`
        : humanSize(size);

      this._diffEl.classList.remove('decrease', 'increase');

      // just displaying a single size?
      if (!comparisonSize) {
        this._diffEl.textContent = '';
      } else if (size === comparisonSize) {
        this._diffEl.textContent = '100%';
      } else {
        this._diffEl.textContent = `${round((size / comparisonSize) * 100, 2)}%`;
        this._diffEl.classList.add(
          size > comparisonSize ? 'increase' : 'decrease',
        );
      }
    }
  }

  let createNanoEvents = () => ({
    events: {},
    emit(event, ...args) {
      let callbacks = this.events[event] || [];
      for (let i = 0, length = callbacks.length; i < length; i++) {
        callbacks[i](...args);
      }
    },
    on(event, cb) {
      this.events[event]?.push(cb) || (this.events[event] = [cb]);
      return () => {
        this.events[event] = this.events[event]?.filter(i => cb !== i);
      }
    }
  });

  class MaterialSlider {
    constructor(rangeElement) {
      // prettier-ignore
      this.container = strToEl(
        '<div class="material-slider">' +
          '<div class="track">' +
            '<div class="track-on"></div>' +
            '<div class="handle">' +
              '<div class="arrow"></div>' +
              '<div class="val"></div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );

      this._range = rangeElement;
      this._handle = this.container.querySelector('.handle');
      this._trackOn = this.container.querySelector('.track-on');
      this._val = this.container.querySelector('.val');

      this._range.parentNode.insertBefore(this.container, this._range);
      this.container.insertBefore(this._range, this.container.firstChild);

      this._range.addEventListener('input', () => this._onInputChange());
      this._range.addEventListener('mousedown', () => this._onRangeMouseDown());
      this._range.addEventListener('touchstart', () => this._onRangeTouchStart());
      this._range.addEventListener('touchend', () => this._onRangeTouchEnd());

      this._setPosition();
    }

    // eslint-disable-next-line accessor-pairs
    set value(newValue) {
      this._range.value = newValue;
      this._update();
    }

    _onRangeTouchStart() {
      this._range.focus();
    }

    _onRangeTouchEnd() {
      this._range.blur();
    }

    _onRangeMouseDown() {
      this._range.classList.add('active');

      const upListener = () => {
        requestAnimationFrame(() => {
          this._range.blur();
        });
        this._range.classList.remove('active');
        document.removeEventListener('mouseup', upListener);
      };

      document.addEventListener('mouseup', upListener);
    }

    _onInputChange() {
      this._update();
    }

    _update() {
      requestAnimationFrame(() => this._setPosition());
    }

    _setPosition() {
      const { min, max, value } = this._range;
      const percent = (Number(value) - min) / (max - min);

      this._trackOn.style.width = this._handle.style.left = `${percent * 100}%`;
      this._val.textContent = value;
    }
  }

  class Settings {
    constructor() {
      this.emitter = createNanoEvents();
      this._throttleTimeout = null;

      domReady.then(() => {
        this.container = document.querySelector('.settings');
        this._pluginInputs = [
          ...this.container.querySelectorAll('.plugins input'),
        ];
        this._globalInputs = [
          ...this.container.querySelectorAll('.global input'),
        ];

        const scroller = this.container.querySelector('.settings-scroller');
        const resetBtn = this.container.querySelector('.setting-reset');
        const ranges = this.container.querySelectorAll('input[type=range]');

        this._resetRipple = new Ripple();
        resetBtn.append(this._resetRipple.container);

        // map real range elements to Slider instances
        this._sliderMap = new WeakMap();

        // enhance ranges
        for (const range of ranges) {
          this._sliderMap.set(range, new MaterialSlider(range));
        }

        this.container.addEventListener('input', (event) =>
          this._onChange(event),
        );
        resetBtn.addEventListener('click', () => this._onReset());

        // TODO: revisit this
        // Stop double-tap text selection.
        // This stops all text selection which is kinda sad.
        // I think this code will bite me.
        scroller.addEventListener('mousedown', (event) => {
          if (event.target.closest('input[type=range]')) return;
          event.preventDefault();
        });
      });
    }

    _onChange(event) {
      clearTimeout(this._throttleTimeout);

      // throttle range
      if (event.target.type === 'range') {
        this._throttleTimeout = setTimeout(
          () => this.emitter.emit('change'),
          150,
        );
      } else {
        this.emitter.emit('change');
      }
    }

    _onReset() {
      this._resetRipple.animate();
      const oldSettings = this.getSettings();

      // Set all inputs according to their initial attributes
      for (const inputEl of this._globalInputs) {
        if (inputEl.type === 'checkbox') {
          inputEl.checked = inputEl.hasAttribute('checked');
        } else if (inputEl.type === 'range') {
          this._sliderMap.get(inputEl).value = inputEl.getAttribute('value');
        }
      }

      for (const inputEl of this._pluginInputs) {
        inputEl.checked = inputEl.hasAttribute('checked');
      }

      this.emitter.emit('reset', oldSettings);
      this.emitter.emit('change');
    }

    setSettings(settings) {
      for (const inputEl of this._globalInputs) {
        if (!(inputEl.name in settings)) continue;

        if (inputEl.type === 'checkbox') {
          inputEl.checked = settings[inputEl.name];
        } else if (inputEl.type === 'range') {
          this._sliderMap.get(inputEl).value = settings[inputEl.name];
        }
      }

      for (const inputEl of this._pluginInputs) {
        if (!(inputEl.name in settings.plugins)) continue;
        inputEl.checked = settings.plugins[inputEl.name];
      }
    }

    getSettings() {
      // fingerprint is used for cache lookups
      const fingerprint = [];
      const output = {
        plugins: {},
      };

      for (const inputEl of this._globalInputs) {
        if (inputEl.name !== 'gzip' && inputEl.name !== 'original') {
          if (inputEl.type === 'checkbox') {
            fingerprint.push(Number(inputEl.checked));
          } else {
            fingerprint.push(`|${inputEl.value}|`);
          }
        }

        output[inputEl.name] =
          inputEl.type === 'checkbox' ? inputEl.checked : inputEl.value;
      }

      for (const inputEl of this._pluginInputs) {
        fingerprint.push(Number(inputEl.checked));
        output.plugins[inputEl.name] = inputEl.checked;
      }

      output.fingerprint = fingerprint.join(',');

      return output;
    }
  }

  class MainMenu {
    constructor() {
      this.emitter = createNanoEvents();
      this.allowHide = false;
      this._spinner = new Spinner();

      domReady.then(() => {
        this.container = document.querySelector('.main-menu');
        this._loadFileInput = this.container.querySelector('.load-file-input');
        this._pasteInput = this.container.querySelector('.paste-input');
        this._loadDemoBtn = this.container.querySelector('.load-demo');
        this._loadFileBtn = this.container.querySelector('.load-file');
        this._pasteLabel = this.container.querySelector('.menu-input');
        this._overlay = this.container.querySelector('.overlay');
        this._menu = this.container.querySelector('.menu');
        const menuBtn = document.querySelector('.menu-btn');

        menuBtn.addEventListener('click', (event) =>
          this._onMenuButtonClick(event),
        );
        this._overlay.addEventListener('click', (event) =>
          this._onOverlayClick(event),
        );
        this._loadFileBtn.addEventListener('click', (event) =>
          this._onLoadFileClick(event),
        );
        this._loadDemoBtn.addEventListener('click', (event) =>
          this._onLoadDemoClick(event),
        );
        this._loadFileInput.addEventListener('change', () =>
          this._onFileInputChange(),
        );
        this._pasteInput.addEventListener('input', () =>
          this._onTextInputChange(),
        );
      });
    }

    show() {
      this.container.classList.remove('hidden');
      transitionFromClass(this._overlay, 'hidden');
      transitionFromClass(this._menu, 'hidden');
    }

    hide() {
      if (!this.allowHide) return;
      this.stopSpinner();
      this.container.classList.add('hidden');
      transitionToClass(this._overlay, 'hidden');
      transitionToClass(this._menu, 'hidden');
    }

    stopSpinner() {
      this._spinner.hide();
    }

    showFilePicker() {
      this._loadFileInput.click();
    }

    setPasteInput(value) {
      this._pasteInput.value = value;
      this._pasteInput.dispatchEvent(new Event('input'));
    }

    _onOverlayClick(event) {
      event.preventDefault();
      this.hide();
    }

    _onMenuButtonClick(event) {
      event.preventDefault();
      this.show();
    }

    _onTextInputChange() {
      const value = this._pasteInput.value;
      if (!value.includes('</svg>')) return;

      this._pasteInput.value = '';
      this._pasteInput.blur();

      this._pasteLabel.append(this._spinner.container);
      this._spinner.show();

      this.emitter.emit('svgDataLoad', {
        data: value,
        filename: 'image.svg',
      });
    }

    _onLoadFileClick(event) {
      event.preventDefault();
      event.target.blur();
      this.showFilePicker();
    }

    async _onFileInputChange() {
      const file = this._loadFileInput.files[0];

      if (!file) return;

      this._loadFileBtn.append(this._spinner.container);
      this._spinner.show();

      this.emitter.emit('svgDataLoad', {
        data: await readFileAsText(file),
        filename: file.name,
      });
    }

    async _onLoadDemoClick(event) {
      event.preventDefault();
      event.target.blur();
      this._loadDemoBtn.append(this._spinner.container);
      this._spinner.show();

      try {
        const data = await fetch('test-svgs/car-lite.svg').then((response) =>
          response.text(),
        );
        this.emitter.emit('svgDataLoad', {
          data,
          filename: 'car-lite.svg',
        });
      } catch {
        this.stopSpinner();

        const error = new Error("Couldn't fetch demo SVG");

        this.emitter.emit('error', { error });
      }
    }
  }

  class Toast {
    constructor(message, duration, buttons, isError) {
      this.container = strToEl(
        '<div class="toast"><div class="toast-content"></div></div>',
      );
      const content = this.container.querySelector('.toast-content');
      this._answerResolve = null;
      this._hideTimeout = null;

      if (isError) {
        content.insertAdjacentHTML('afterbegin', '<pre><code></code></pre>');
        content.querySelector('code').textContent = message;
      } else {
        content.textContent = message;
      }

      this.answer = new Promise((resolve) => {
        this._answerResolve = resolve;
      });

      for (const button of buttons) {
        const buttonElement = document.createElement('button');
        buttonElement.className = 'unbutton';
        buttonElement.textContent = button;
        buttonElement.type = 'button';
        buttonElement.addEventListener('click', () => {
          this._answerResolve(button);
        });
        this.container.append(buttonElement);
      }

      if (duration) {
        this._hideTimeout = setTimeout(() => this.hide(), duration);
      }
    }

    hide() {
      clearTimeout(this._hideTimeout);
      this._answerResolve();
      return transitionToClass(this.container, 'hide');
    }
  }

  class Toasts {
    constructor() {
      this.container = strToEl('<div class="toasts"></div>');
    }

    show(message, { duration = 0, buttons = ['dismiss'], isError = false } = {}) {
      const toast = new Toast(message, duration, buttons, isError);
      this.container.append(toast.container);

      toast.answer
        .then(() => toast.hide())
        .then(() => {
          toast.container.remove();
        });

      return toast;
    }
  }

  class FileDrop {
    constructor() {
      this.emitter = createNanoEvents();
      this.container = strToEl('<div class="drop-overlay">Drop it!</div>');

      // drag events are horrid
      this._activeEnters = 0;
      this._currentEnteredElement = null;

      domReady.then(() => {
        document.addEventListener('dragover', (event) => event.preventDefault());
        document.addEventListener('dragenter', (event) =>
          this._onDragEnter(event),
        );
        document.addEventListener('dragleave', () => this._onDragLeave());
        document.addEventListener('drop', (event) => this._onDrop(event));
      });
    }

    _onDragEnter(event) {
      // TODO: revisit this
      // Firefox double-fires on window enter, this works around it
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1124645
      if (this._currentEnteredElement === event.target) return;
      this._currentEnteredElement = event.target;

      if (!this._activeEnters++) {
        transitionToClass(this.container);
      }
    }

    _onDragLeave() {
      this._currentEnteredElement = null;

      if (!--this._activeEnters) {
        transitionFromClass(this.container);
      }
    }

    async _onDrop(event) {
      event.preventDefault();

      this._activeEnters = 0;
      transitionFromClass(this.container);

      const file = event.dataTransfer.files[0];
      if (!file) return;

      this.emitter.emit('svgDataLoad', {
        data: await readFileAsText(file),
        filename: file.name,
      });
    }
  }

  class Preloader {
    constructor() {
      domReady.then(() => {
        this.container = document.querySelector('.preloader');
        this.activated = this.container.classList.contains('active');
        this.hide();
      });
    }

    async hide() {
      await transitionFromClass(this.container, 'active');
      this.container.style.display = 'none';
    }
  }

  class Changelog {
    constructor(loadedVersion) {
      this.container = strToEl('<section class="changelog"></section>');
      this._loadedVersion = loadedVersion;
    }

    async showLogFrom(lastLoadedVersion) {
      if (lastLoadedVersion === this._loadedVersion) return;
      const changelog = await fetch('changelog.json').then((response) =>
        response.json(),
      );
      let startIndex = 0;
      let endIndex = 0;

      for (const [i, entry] of Object.entries(changelog)) {
        if (entry.version === this._loadedVersion) {
          startIndex = i;
        } else if (entry.version === lastLoadedVersion) {
          break;
        }

        endIndex = i + 1;
      }

      const changeList = changelog
        .slice(startIndex, endIndex)
        // TODO: remove `reduce`
        // eslint-disable-next-line unicorn/no-array-reduce
        .reduce((array, entry) => array.concat(entry.changes), [])
        .map((change) => escapeHtmlTag`<li>${change}</li>`);

      this.container.append(
        strToEl('<h1>Updated!</h1>'),
        strToEl(`<ul>${changeList.join('')}</ul>`),
      );

      await domReady;
      transitionToClass(this.container);
    }
  }

  class ResultsContainer {
    constructor(results) {
      this._results = results;

      domReady.then(() => {
        this._container = document.querySelector('.results-container');
        this._mobileContainer = document.querySelector(
          '.results-container-mobile',
        );
        this._query = matchMedia('(min-width: 640px)');

        this._query.addListener(() => this._positionResults());
        this._positionResults();
      });
    }

    _positionResults() {
      if (this._query.matches) {
        this._container.append(this._results.container);
      } else {
        this._mobileContainer.append(this._results.container);
      }
    }
  }

  /**
   * Tabs that toggle between showing the SVG image and XML markup.
   */
  class ViewToggler {
    constructor() {
      this.emitter = createNanoEvents();
      /** @type {HTMLFormElement | null} */
      this.container = null;

      domReady.then(() => {
        this.container = document.querySelector('.view-toggler');

        // stop browsers remembering previous form state
        this.container.output[0].checked = true;

        this.container.addEventListener('change', () => {
          this.emitter.emit('change', {
            value: this.container.output.value,
          });
        });
      });
    }
  }

  // TODO: switch to Map/Set

  class ResultsCache {
    constructor(size) {
      this._size = size;
      this.purge();
    }

    purge() {
      this._fingerprints = [];
      this._items = [];
      this._index = 0;
    }

    add(fingerprint, svgFile) {
      const oldItem = this._items[this._index];

      if (oldItem) {
        // gc blob url
        oldItem.release();
      }

      this._fingerprints[this._index] = fingerprint;
      this._items[this._index] = svgFile;

      this._index = (this._index + 1) % this._size;
    }

    match(fingerprint) {
      return this._items[this._fingerprints.indexOf(fingerprint)];
    }
  }

  class MainUi {
    constructor(...elements) {
      this._activated = false;
      this._toActivate = elements;
    }

    activate() {
      if (this._activated) return;
      this._activated = true;

      return Promise.all(
        this._toActivate.map((element) => transitionToClass(element)),
      );
    }
  }

  function removeUnusedTextCode(svgText) {
    if (document.readyState === 'loading') return svgText;

    const fontAttributes = [
      'font-style',
      'font-variant',
      'font-weight',
      'font-stretch',
      'font-size',
      'font-family',
      'line-height',
      'letter-spacing',
      'word-spacing',
      'writing-mode',
      'white-space',
      'text-align',
      'text-anchor',
      'text-indent',
      'text-transform',
      'text-orientation',
      'text-decoration-color',
      'text-decoration-line',
      'text-decoration-style',
      'text-decoration-style',
      'text-decoration-thickness',
      'font-variant',
      'font-variant-east-asian',
      'font-variant-ligatures',
      'font-variant-caps',
      'font-variant-numeric',
      'font-feature-settings',
      'font-variant-position',
      'font-variant-alternates',
      'font-variation-settings',
      '-inkscape-stroke',
      '-inkscape-font-specification',
    ];

    const svg = document.createElement('html');
    svg.innerHTML = svgText;
    const paths = svg.querySelectorAll('path');
    const gs = svg.querySelectorAll('g');
    for (const a of fontAttributes) {
      for (const path of paths) {
        path.style.removeProperty(a);
        path.removeAttribute(a);
      }

      for (const group of gs) {
        group.style.removeProperty(a);
        group.removeAttribute(a);
      }
    }

    return svg.querySelectorAll('svg')[0].outerHTML;
  }

  function removeUnusualAttributes(svgText) {
    if (document.readyState === 'loading') return svgText;

    const unusualAttributes = [
      'shape-margin',
      'inline-size',
      'isolation',
      'mix-blend-mode',
    ];

    const svg = document.createElement('html');
    svg.innerHTML = svgText;
    const paths = svg.querySelectorAll('path');
    const gs = svg.querySelectorAll('g');
    for (const a of unusualAttributes) {
      for (const path of paths) {
        path.style.removeProperty(a);
        path.removeAttribute(a);
      }

      for (const group of gs) {
        group.style.removeProperty(a);
        group.removeAttribute(a);
      }
    }

    return svg.querySelectorAll('svg')[0].outerHTML;
  }

  const svgo = new Svgo();

  class MainController {
    constructor() {
      // ui components
      this._mainUi = null;
      this._outputUi = new Output();
      this._downloadButtonUi = new DownloadButton();
      this._copyButtonUi = new CopyButton();
      this._resultsUi = new Results();
      this._settingsUi = new Settings();
      this._mainMenuUi = new MainMenu();
      this._toastsUi = new Toasts();

      const bgFillUi = new BgFillButton();
      const dropUi = new FileDrop();
      const preloaderUi = new Preloader();
      const changelogUi = new Changelog(self.version);
      // _resultsContainerUi is unused
      this._resultsContainerUi = new ResultsContainer(this._resultsUi);
      const viewTogglerUi = new ViewToggler();

      // ui events
      this._settingsUi.emitter.on('change', () => this._onSettingsChange());
      this._settingsUi.emitter.on('reset', (oldSettings) =>
        this._onSettingsReset(oldSettings),
      );
      this._mainMenuUi.emitter.on('svgDataLoad', (event) =>
        this._onInputChange(event),
      );
      dropUi.emitter.on('svgDataLoad', (event) => this._onInputChange(event));
      this._mainMenuUi.emitter.on('error', ({ error }) =>
        this._handleError(error),
      );
      viewTogglerUi.emitter.on('change', (event) =>
        this._outputUi.set(event.value),
      );
      window.addEventListener('keydown', (event) => this._onGlobalKeyDown(event));
      window.addEventListener('paste', (event) => this._onGlobalPaste(event));
      window.addEventListener('copy', (event) => this._onGlobalCopy(event));

      // state
      this._inputItem = null;
      this._cache = new ResultsCache(10);
      this._latestCompressJobId = 0;
      this._userHasInteracted = false;
      this._reloading = false;

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker
          .register('sw.js', { scope: './' })
          .then((registration) => {
            registration.addEventListener('updatefound', () =>
              this._onUpdateFound(registration),
            );
          });
      }

      // tell the user about the latest update
      idbKeyval.get('last-seen-version').then((lastSeenVersion) => {
        if (lastSeenVersion) changelogUi.showLogFrom(lastSeenVersion);
        idbKeyval.set('last-seen-version', self.version);
      });

      domReady.then(() => {
        const container = document.querySelector('.app-output');
        const actionContainer = container.querySelector(
          '.action-button-container',
        );
        const minorActionContainer = container.querySelector(
          '.minor-action-container',
        );
        const toolbarElement = container.querySelector('.toolbar');
        const outputElement = container.querySelector('.output');
        const menuExtraElement = container.querySelector('.menu-extra');

        // elements for intro anim
        this._mainUi = new MainUi(
          toolbarElement,
          actionContainer,
          this._outputUi.container,
          this._settingsUi.container,
        );

        minorActionContainer.append(
          bgFillUi.container,
          this._copyButtonUi.container,
        );
        actionContainer.append(this._downloadButtonUi.container);
        outputElement.append(this._outputUi.container);
        container.append(this._toastsUi.container, dropUi.container);
        menuExtraElement.append(changelogUi.container);

        // load previous settings
        this._loadSettings();

        // someone managed to hit the preloader, aww
        if (preloaderUi.activated) {
          this._toastsUi.show('Ready now!', { duration: 3000 });
        }
      });
    }

    _onGlobalKeyDown(event) {
      if (event.key === 'o' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this._mainMenuUi.showFilePicker();
      }

      if (event.key === 'Escape') this._mainMenuUi.hide();
    }

    _onGlobalPaste(event) {
      const value = event.clipboardData.getData('text');
      if (!value.includes('</svg>')) {
        this._toastsUi.show('Pasted value not an SVG', { duration: 2000 });
      } else {
        this._mainMenuUi.setPasteInput(value);
        event.preventDefault();
      }
    }

    _onGlobalCopy(event) {
      const selection = window.getSelection();
      if (!selection.isCollapsed) return;

      this._toastsUi.show(
        this._copyButtonUi.copyText() ? 'Copy successful' : 'Nothing to copy',
        { duration: 2000 },
      );

      event.preventDefault();
    }

    _onUpdateFound(registration) {
      const newWorker = registration.installing;

      registration.installing.addEventListener('statechange', async () => {
        if (this._reloading) return;

        // the very first activation!
        // tell the user stuff works offline
        if (
          newWorker.state === 'activated' &&
          !navigator.serviceWorker.controller
        ) {
          this._toastsUi.show('Ready to work offline', { duration: 5000 });
          return;
        }

        if (
          newWorker.state === 'activated' &&
          navigator.serviceWorker.controller
        ) {
          // if the user hasn't interacted yet, do a sneaky reload
          if (!this._userHasInteracted) {
            this._reloading = true;
            location.reload();
            return;
          }

          // otherwise, show the user an alert
          const toast = this._toastsUi.show('Update available', {
            buttons: ['reload', 'dismiss'],
          });
          const answer = await toast.answer;

          if (answer === 'reload') {
            this._reloading = true;
            location.reload();
          }
        }
      });
    }

    _onSettingsChange() {
      const settings = this._settingsUi.getSettings();
      this._saveSettings(settings);
      this._compressSvg(settings);
    }

    async _onSettingsReset(oldSettings) {
      const toast = this._toastsUi.show('Settings reset', {
        buttons: ['undo', 'dismiss'],
        duration: 5000,
      });
      const answer = await toast.answer;

      if (answer === 'undo') {
        this._settingsUi.setSettings(oldSettings);
        this._onSettingsChange();
      }
    }

    async _onInputChange({ data, filename }) {
      const settings = this._settingsUi.getSettings();
      this._userHasInteracted = true;

      try {
        this._inputItem = await svgo.wrapOriginal(data);
        this._inputFilename = filename;
      } catch (error) {
        this._mainMenuUi.stopSpinner();
        this._handleError(new Error(`Load failed: ${error.message}`));
        return;
      }

      this._cache.purge();

      this._compressSvg(settings);
      this._outputUi.reset();
      this._mainUi.activate();
      this._mainMenuUi.allowHide = true;
      this._mainMenuUi.hide();
    }

    _handleError(error) {
      this._toastsUi.show(error.message, { isError: true });
      console.error(error);
    }

    async _loadSettings() {
      const settings = await idbKeyval.get('settings');
      if (settings) this._settingsUi.setSettings(settings);
    }

    _saveSettings(settings) {
      // doesn't make sense to retain the "show original" option
      const { original, ...settingsToKeep } = settings;
      idbKeyval.set('settings', settingsToKeep);
    }

    async _compressSvg(settings) {
      const thisJobId = (this._latestCompressJobId = Math.random());

      await svgo.abort();

      if (thisJobId !== this._latestCompressJobId) {
        // while we've been waiting, there's been a newer call
        // to _compressSvg, we don't need to do anything
        return;
      }

      if (settings.original) {
        this._updateForFile(this._inputItem, {
          compress: settings.gzip,
        });
        return;
      }

      const cacheMatch = this._cache.match(settings.fingerprint);

      if (cacheMatch) {
        this._updateForFile(cacheMatch, {
          compareToFile: this._inputItem,
          compress: settings.gzip,
        });
        return;
      }

      this._downloadButtonUi.working();

      try {
        let svgText = this._inputItem.text;
        if (settings.remUnusedTextCode) svgText = removeUnusedTextCode(svgText);
        if (settings.remUnusualAttributes)
          svgText = removeUnusualAttributes(svgText);
        const resultFile0 = await svgo.process(svgText, settings);
        let resultFile;
        if (settings.remUnusedTextCode || settings.remUnusualAttributes) {
          svgText = settings.remUnusedTextCode
            ? removeUnusedTextCode(resultFile0.text)
            : resultFile0.text;
          if (settings.remUnusualAttributes)
            svgText = removeUnusualAttributes(svgText);
          resultFile = await svgo.process(svgText, settings);
        } else resultFile = resultFile0;

        this._updateForFile(resultFile, {
          compareToFile: this._inputItem,
          compress: settings.gzip,
        });

        this._cache.add(settings.fingerprint, resultFile);
      } catch (error) {
        if (error.name === 'AbortError') return;
        error.message = `Minifying error: ${error.message}`;
        this._handleError(error);
      } finally {
        this._downloadButtonUi.done();
      }
    }

    async _updateForFile(svgFile, { compareToFile, compress }) {
      this._outputUi.update(svgFile);
      this._downloadButtonUi.setDownload(this._inputFilename, svgFile);
      this._copyButtonUi.setCopyText(svgFile.text);

      this._resultsUi.update({
        comparisonSize: compareToFile && (await compareToFile.size({ compress })),
        size: await svgFile.size({ compress }),
      });
    }
  }

  trackFocusMethod();
  new MainController(); // eslint-disable-line no-new

})();
//# sourceMappingURL=page.js.map
