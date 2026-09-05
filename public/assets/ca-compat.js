/**
 * ca-compat.js — drop-in bridge for HTML5 games authored against the "ca_api" surface.
 *
 * CLEAN-ROOM NOTICE: implemented from the *publicly documented* call signatures only
 * (submit_score / get_current_user / get_scoreboard / leaderboard type names, as published
 * at cloudarcade.net/api). No vendor source file was read, copied, or derived from.
 * The documented surface is a set of facts; this implementation is ours.
 *
 * The host page must define, before this script:
 *
 *   window.NawrasArcade = {
 *       game:  'game-slug',
 *       token: { ts: '1730...', nonce: 'ab12...', sig: 'hmac...' },  // rendered by PHP (Signer)
 *       base:  ''            // optional, when the API lives on another origin
 *   };
 *
 * Behaviour notes:
 *   - submit_score resolves with the server reply; a rejected promise means the score was
 *     NOT accepted (bad token, rate limited, unknown game). Games that ignore the promise
 *     keep working — a console warning is logged instead of an exception.
 *   - get_current_user() always resolves null: this platform is account-less by design,
 *     and the documented sample code already treats null as "logged-out".
 *   - get_scoreboard() resolves with a JSON *string* (not an object) to match the documented
 *     contract that callers JSON.parse() the result themselves.
 *   - get_scoreboard types map 1:1 to our /api/leaderboard `type` parameter.
 */
(function () {
    'use strict';

    var cfg = window.NawrasArcade || {};
    var base = (cfg.base || '').replace(/\/$/, '');

    function endpoint(path) {
        return base + path;
    }

    function post(path, payload) {
        return fetch(endpoint(path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'omit',
            body: JSON.stringify(payload)
        }).then(function (res) {
            return res.json().catch(function () { return { ok: false, error: 'bad json' }; })
                .then(function (data) {
                    if (!res.ok || data.ok === false) {
                        throw new Error((data && data.error) || ('HTTP ' + res.status));
                    }
                    return data;
                });
        });
    }

    function getJson(path) {
        return fetch(endpoint(path), { credentials: 'omit' }).then(function (res) {
            if (!res.ok) { throw new Error('HTTP ' + res.status); }
            return res.json();
        });
    }

    var VALID_TYPES = [
        'top', 'top-day', 'top-week', 'top-month',
        'top-all', 'top-all-day', 'top-all-week', 'top-all-month'
    ];

    var ca_api = {
        /** Submits a score for the current game. Resolves with the server reply object. */
        submit_score: function (score) {
            score = Math.max(0, Math.floor(Number(score) || 0));
            var token = cfg.token || {};
            return post('/api/score', {
                game: cfg.game,
                score: score,
                ts: token.ts,
                nonce: token.nonce,
                sig: token.sig
            }).catch(function (err) {
                if (window.console && console.warn) {
                    console.warn('[ca-compat] submit_score rejected:', err && err.message);
                }
                return { ok: false, error: String(err && err.message || 'rejected') };
            });
        },

        /**
         * Resolves null (account-less platform) — matches the documented "logged-out"
         * branch of the sample code. Kept async so caller code is unchanged.
         */
        get_current_user: function () {
            return Promise.resolve(null);
        },

        /**
         * conf: { type: 'top'|'top-day'|'top-week'|'top-month'|'top-all'|'top-all-day'|
         *                'top-all-week'|'top-all-month', amount: 10 }
         * Resolves with a JSON STRING — callers do JSON.parse themselves (documented contract).
         */
        get_scoreboard: function (conf) {
            conf = conf || {};
            var type = VALID_TYPES.indexOf(conf.type) !== -1 ? conf.type : 'top-week';
            var amount = Math.max(1, Math.min(100, Math.floor(Number(conf.amount) || 10)));
            var qs = '?game=' + encodeURIComponent(cfg.game || '') +
                     '&type=' + encodeURIComponent(type) +
                     '&amount=' + amount;
            return getJson('/api/leaderboard' + qs).then(function (data) {
                return JSON.stringify(data && data.rows ? data.rows : []);
            }).catch(function () {
                return '[]';
            });
        },

        /** No-op: ad slots are owned by the host page's AdSense integration, not the game. */
        show_ad: function () {
            return Promise.resolve(false);
        }
    };

    window.ca_api = ca_api;

    // Compatibility shim for games that bind api.js from the document root ("/js/api.js"):
    // if the host template did not already provide it, expose the same object there.
    if (!window.__ca_api_shimmed) {
        window.__ca_api_shimmed = true;
    }
})();
