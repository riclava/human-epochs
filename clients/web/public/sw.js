// Human Epochs service worker. It keeps one offline page for when the network is gone, and shows review reminders.
// Conversations need the server, so nothing else is cached.
const cacheName = 'human-epochs-offline-v1'
const offlinePage = '/offline.html'

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll([offlinePage, '/icon.svg'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(name => name !== cacheName).map(name => caches.delete(name))))
    .then(() => self.clients.claim()))
})

// Pages always come from the network; only a failed page load falls back to the offline page.
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => caches.match(offlinePage)))
})

self.addEventListener('push', event => {
  let message = {}
  try { message = event.data ? event.data.json() : {} } catch { /* An unreadable message still shows a generic reminder. */ }
  event.waitUntil(self.registration.showNotification(message.title || 'Human Epochs', {
    body: message.body || '有一项复习到时间了。',
    tag: message.tag,
    icon: '/icon-192.png',
    lang: 'zh-CN',
    data: { url: message.url || '/#/today' },
  }))
})

// Opening a reminder focuses an open Human Epochs window, or opens one, at Today.
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/#/today', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const open = windows.find(client => new URL(client.url).origin === self.location.origin)
    if (!open) return self.clients.openWindow(url)
    return open.focus().then(client => client.navigate(url))
  }))
})
