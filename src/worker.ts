/**
 * MAL Rater — a personal, temporary tool to score a big backlog of already-watched
 * anime and write the scores straight back to MyAnimeList.
 *
 * Auth: MAL OAuth2 (PKCE, `plain` — MAL doesn't support S256). Tokens live in KV,
 * keyed by a random session id in an httpOnly cookie. Score writes go to the
 * official MAL API. Card art + synopsis come from Jikan's *core* endpoints (up).
 */
export interface Env {
	ASSETS: { fetch(r: Request): Promise<Response> };
	TOKENS: KVNamespace;
	MAL_CLIENT_ID: string;
	MAL_CLIENT_SECRET: string;
}

const MAL_AUTH = 'https://myanimelist.net/v1/oauth2/authorize';
const MAL_TOKEN = 'https://myanimelist.net/v1/oauth2/token';
const MAL_API = 'https://api.myanimelist.net/v2';
const SESS_TTL = 60 * 60 * 24 * 30;

const json = (d: unknown, status = 200): Response =>
	new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });

function rand(n: number): string {
	const a = new Uint8Array(n);
	crypto.getRandomValues(a);
	return [...a].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
}
const setCookie = (name: string, val: string, maxAge: number) =>
	`${name}=${val}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
function getCookie(req: Request, name: string): string | null {
	const m = (req.headers.get('Cookie') ?? '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
	return m ? m[1] : null;
}

type Sess = { sid: string; access: string; refresh: string };

async function tokenReq(env: Env, params: Record<string, string>) {
	const r = await fetch(MAL_TOKEN, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.MAL_CLIENT_ID,
			client_secret: env.MAL_CLIENT_SECRET,
			...params,
		}),
	});
	if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
	return (await r.json()) as { access_token: string; refresh_token: string };
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const redirectUri = `${url.origin}/oauth/callback`;
		const p = url.pathname;

		// ── OAuth: start ────────────────────────────────────────────────────────
		if (p === '/oauth/login') {
			if (!env.MAL_CLIENT_ID || !env.MAL_CLIENT_SECRET) {
				return new Response('MAL_CLIENT_ID / MAL_CLIENT_SECRET not set on the Worker.', {
					status: 500,
				});
			}
			const verifier = rand(96); // plain PKCE: challenge === verifier (43–128 chars)
			const state = rand(32);
			await env.TOKENS.put(`pkce:${state}`, verifier, { expirationTtl: 600 });
			const q = new URLSearchParams({
				response_type: 'code',
				client_id: env.MAL_CLIENT_ID,
				code_challenge: verifier,
				code_challenge_method: 'plain',
				state,
				redirect_uri: redirectUri,
			});
			return Response.redirect(`${MAL_AUTH}?${q}`, 302);
		}

		// ── OAuth: callback ──────────────────────────────────────────────────────
		if (p === '/oauth/callback') {
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');
			if (!code || !state) return new Response('missing code/state', { status: 400 });
			const verifier = await env.TOKENS.get(`pkce:${state}`);
			if (!verifier) return new Response('login expired — try again', { status: 400 });
			try {
				const tok = await tokenReq(env, {
					code,
					code_verifier: verifier,
					grant_type: 'authorization_code',
					redirect_uri: redirectUri,
				});
				const sid = rand(32);
				await env.TOKENS.put(
					`sess:${sid}`,
					JSON.stringify({ access: tok.access_token, refresh: tok.refresh_token }),
					{ expirationTtl: SESS_TTL },
				);
				return new Response(null, {
					status: 302,
					headers: { Location: '/', 'Set-Cookie': setCookie('sid', sid, SESS_TTL) },
				});
			} catch (e) {
				return new Response(`oauth error: ${(e as Error).message}`, { status: 500 });
			}
		}

		if (p === '/oauth/logout') {
			const sid = getCookie(request, 'sid');
			if (sid) await env.TOKENS.delete(`sess:${sid}`);
			return new Response(null, {
				status: 302,
				headers: { Location: '/', 'Set-Cookie': setCookie('sid', '', 0) },
			});
		}

		// session helpers
		const getSess = async (): Promise<Sess | null> => {
			const sid = getCookie(request, 'sid');
			if (!sid) return null;
			const raw = await env.TOKENS.get(`sess:${sid}`);
			return raw ? { sid, ...JSON.parse(raw) } : null;
		};
		const malFetch = async (sess: Sess, path: string, init?: RequestInit): Promise<Response> => {
			const call = () =>
				fetch(`${MAL_API}${path}`, {
					...init,
					headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${sess.access}` },
				});
			let r = await call();
			if (r.status === 401 && sess.refresh) {
				const t = await tokenReq(env, { grant_type: 'refresh_token', refresh_token: sess.refresh });
				sess.access = t.access_token;
				sess.refresh = t.refresh_token || sess.refresh;
				await env.TOKENS.put(`sess:${sess.sid}`, JSON.stringify({ access: sess.access, refresh: sess.refresh }), {
					expirationTtl: SESS_TTL,
				});
				r = await call();
			}
			return r;
		};

		// ── who am I? ────────────────────────────────────────────────────────────
		if (p === '/api/me') {
			const sess = await getSess();
			if (!sess) return json({ authed: false });
			const r = await malFetch(sess, '/users/@me?fields=name');
			if (!r.ok) return json({ authed: false });
			return json({ authed: true, name: ((await r.json()) as { name?: string }).name });
		}

		// ── the signed-in user's own completed-but-unrated anime (the queue) ─────
		if (p === '/api/queue') {
			const sess = await getSess();
			if (!sess) return json({ error: 'not authed' }, 401);
			// biome-ignore lint: loose
			const out: any[] = [];
			let next: string | null =
				'/users/@me/animelist?status=completed&limit=1000&nsfw=true&fields=list_status,alternative_titles';
			for (let page = 0; page < 4 && next; page++) {
				const r = await malFetch(sess, next);
				if (!r.ok) break;
				// biome-ignore lint: loose
				const j = (await r.json()) as any;
				for (const it of j.data ?? []) {
					if ((it.list_status?.score ?? 0) === 0) {
						out.push({ id: it.node.id, title: it.node.title, en: it.node.alternative_titles?.en || null });
					}
				}
				next = j.paging?.next ? j.paging.next.slice('https://api.myanimelist.net/v2'.length) : null;
			}
			return json({ queue: out });
		}

		// ── card details — MAL API first (we're authed), Jikan as fallback ───────
		if (p.startsWith('/api/anime/')) {
			const id = p.split('/').pop();
			const cache = caches.default;
			const cacheKey = new Request(`${url.origin}/api/anime/${id}`);
			const hit = await cache.match(cacheKey);
			if (hit) return hit;

			// biome-ignore lint: external API responses are loosely typed on purpose
			const map = (x: any) => (x?.name as string) ?? String(x);
			const TYPE: Record<string, string> = {
				tv: 'TV', movie: 'Movie', ova: 'OVA', ona: 'ONA',
				special: 'Special', music: 'Music', tv_special: 'TV Special',
			};
			// biome-ignore lint: loose payload
			let payload: any = null;

			// Primary: official MyAnimeList API via client-id (public reference data —
			// no session needed, no Jikan rate limits).
			if (env.MAL_CLIENT_ID) {
				const fields =
					'alternative_titles,main_picture,synopsis,mean,num_episodes,media_type,start_season,genres,studios';
				const r = await fetch(`${MAL_API}/anime/${id}?fields=${fields}`, {
					headers: { 'X-MAL-CLIENT-ID': env.MAL_CLIENT_ID },
				});
				if (r.ok) {
					// biome-ignore lint: loose
					const d = (await r.json()) as any;
					payload = {
						id: d.id,
						title: d.title,
						title_en: d.alternative_titles?.en || null,
						image: d.main_picture?.large ?? d.main_picture?.medium ?? null,
						synopsis: (d.synopsis ?? '').replace(/\s+/g, ' ').slice(0, 340),
						year: d.start_season?.year ?? null,
						episodes: d.num_episodes ?? null,
						type: TYPE[d.media_type] ?? d.media_type ?? null,
						community: d.mean ?? null,
						genres: (d.genres ?? []).map(map),
						studios: (d.studios ?? []).map(map),
						url: `https://myanimelist.net/anime/${id}`,
					};
				}
			}

			// Fallback: Jikan core (with backoff) if MAL didn't answer.
			if (!payload) {
				let jr: Response | undefined;
				for (let i = 0; i < 4; i++) {
					jr = await fetch(`https://api.jikan.moe/v4/anime/${id}`);
					if (jr.status !== 429) break;
					await new Promise((res) => setTimeout(res, 600 * (i + 1)));
				}
				if (jr?.ok) {
					// biome-ignore lint: loose
					const d = (((await jr.json()) as any).data ?? {}) as any;
					payload = {
						id: d.mal_id,
						title: d.title,
						title_en: d.title_english ?? null,
						image: d.images?.jpg?.large_image_url ?? d.images?.jpg?.image_url ?? null,
						synopsis: (d.synopsis ?? '').replace(/\s+/g, ' ').slice(0, 340),
						year: d.year,
						episodes: d.episodes,
						type: d.type,
						community: d.score,
						genres: (d.genres ?? []).map(map),
						studios: (d.studios ?? []).map(map),
						url: d.url,
					};
				}
			}

			if (!payload) return json({ id: Number(id), error: 'no data' });
			const resp = json(payload);
			resp.headers.set('Cache-Control', 'public, max-age=604800');
			ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			return resp;
		}

		// ── submit a score → MAL ──────────────────────────────────────────────────
		if (p === '/api/rate' && request.method === 'POST') {
			const sess = await getSess();
			if (!sess) return json({ error: 'not authed' }, 401);
			const { id, score } = (await request.json()) as { id: number; score: number };
			const n = Math.max(1, Math.min(10, Math.floor(Number(score))));
			if (!id || !Number.isFinite(n)) return json({ error: 'bad input' }, 400);
			const r = await malFetch(sess, `/anime/${id}/my_list_status`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ score: String(n) }),
			});
			if (!r.ok) return json({ error: `mal ${r.status}: ${await r.text()}` }, r.status);
			return json({ ok: true, score: n });
		}

		return env.ASSETS.fetch(request);
	},
};
