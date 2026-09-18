/* YHACK'26 service worker — issue notifications for the core team and room operators. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'YHACK\'26', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'YHACK\'26';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      // Urgent issues stay on screen until someone deals with them.
      requireInteraction: Boolean(data.urgent),
      data: { url: data.url || '/' },
      vibrate: data.urgent ? [200, 100, 200, 100, 400] : [120],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.split('?')[0] === target.split('?')[0] && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
