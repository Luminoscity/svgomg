(function () {
  'use strict';

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

  /* globals "1.16.0":false */

  const version = "1.16.0";
  const cachePrefix = 'svgomg-';
  const staticCacheName = `${cachePrefix}static-${version}`;
  const fontCacheName = `${cachePrefix}fonts`;
  const expectedCaches = new Set([staticCacheName, fontCacheName]);

  addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const activeVersionPromise = idbKeyval.get('active-version');
        const cache = await caches.open(staticCacheName);

        await cache.addAll([
          './',
          'all.css',
          'changelog.json',
          'fonts/code-latin.woff2',
          'imgs/icon.png',
          'js/gzip-worker.js',
          'js/page.js',
          'js/prism-worker.js',
          'js/svgo-worker.js',
          'test-svgs/car-lite.svg',
        ]);

        const activeVersion = await activeVersionPromise;

        // If it's a major version change, don't skip waiting
        if (
          !activeVersion ||
          activeVersion.split('.')[0] === version.split('.')[0]
        ) {
          self.skipWaiting();
        }
      })(),
    );
  });

  addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        // remove caches beginning "svgomg-" that aren't in expectedCaches
        const cacheNames = await caches.keys();

        await Promise.all(
          cacheNames
            .filter(
              (cacheName) =>
                cacheName.startsWith(cachePrefix) &&
                !expectedCaches.has(cacheName),
            )
            .map((cacheName) => caches.delete(cacheName)),
        );

        await idbKeyval.set('active-version', version);
      })(),
    );
  });

  async function handleFontRequest(request) {
    const match = await caches.match(request);
    if (match) return match;

    const [response, fontCache] = await Promise.all([
      fetch(request),
      caches.open(fontCacheName),
    ]);

    fontCache.put(request, response.clone());
    return response;
  }

  addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (url.pathname.endsWith('.woff2')) {
      event.respondWith(handleFontRequest(event.request));
      return;
    }

    event.respondWith(
      caches
        .match(event.request)
        .then((response) => response || fetch(event.request)),
    );
  });

})();
//# sourceMappingURL=sw.js.map
