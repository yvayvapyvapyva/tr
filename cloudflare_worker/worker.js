// Cloudflare Worker — прокси отчётов в Telegram Bot API.
//
// Клиент приложения шлёт POST { text } сюда (workers.dev доступен из РФ),
// Worker со своей стороны пересылает сообщение в api.telegram.org,
// гарантированно доступный из глобальной сети Cloudflare.

export default {
    async fetch(request, env) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Report-Key'
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (request.method !== 'POST') {
            return new Response(JSON.stringify({ ok: false, error: 'method' }), {
                status: 405,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        try {
            if (env.REPORT_KEY) {
                const key = request.headers.get('X-Report-Key');
                if (key !== env.REPORT_KEY) {
                    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
                        status: 403,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }
            }

            const body = await request.json();
            const text = String(body.text || '').trim();
            if (!text) {
                return new Response(JSON.stringify({ ok: true, skipped: true }), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            const res = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: env.REPORT_CHAT_ID,
                    text: text,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            });

            const ok = res.ok;
            return new Response(JSON.stringify({ ok }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        } catch (e) {
            return new Response(JSON.stringify({ ok: false, error: String(e) }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }
};