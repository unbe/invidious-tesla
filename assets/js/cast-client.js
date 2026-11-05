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
                            let targetUrl = '';
                            if (msg.videoId) {
                                targetUrl = '/watch?v=' + encodeURIComponent(msg.videoId) + '&tesla=true';
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
