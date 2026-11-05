(function() {
    'use strict';

    function initCastClient() {
        const eventsUrl = '/api/cast/events';
        let evtSource = null;

        function connect() {
            try {
                evtSource = new EventSource(eventsUrl);
                evtSource.onmessage = function(event) {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'play' && (msg.videoId || msg.url)) {
                            const currentSenderId = sessionStorage.getItem('piped_sender_id');
                            if (msg.senderId && currentSenderId && msg.senderId === currentSenderId) {
                                return; // Ignore our own cast
                            }

                            let targetUrl = '';
                            if (msg.videoId) {
                                targetUrl = '/watch?v=' + encodeURIComponent(msg.videoId) + '&tesla=true';
                                if (msg.time && msg.time > 0) {
                                    targetUrl += '&t=' + encodeURIComponent(msg.time);
                                }
                            } else if (msg.url) {
                                const urlObj = new URL(msg.url, window.location.origin);
                                targetUrl = urlObj.pathname + urlObj.search;
                                if (!targetUrl.includes('tesla=true')) {
                                    targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'tesla=true';
                                }
                            }
                            if (targetUrl) {
                                window.location.href = targetUrl;
                            }
                        }
                    } catch (err) {
                        console.warn('Cast event parse error:', err);
                    }
                };

                evtSource.onerror = function() {
                    if (evtSource) {
                        evtSource.close();
                        evtSource = null;
                    }
                    setTimeout(connect, 5000);
                };
            } catch (err) {
                setTimeout(connect, 5000);
            }
        }

        connect();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCastClient);
    } else {
        initCastClient();
    }
})();
