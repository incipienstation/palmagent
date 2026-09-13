import { execFileSync } from 'node:child_process';
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export function releaseBot(env, lookup = (login) => JSON.parse(execFileSync('gh', ['api', `users/${login}`], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}))) {
  const app = Boolean(env.RELEASE_APP_CLIENT_ID);
  const slug = app ? env.RELEASE_APP_SLUG : 'github-actions';
  assert(typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), 'Missing or invalid release App identity');
  assert(app || !env.RELEASE_APP_SLUG, 'Release App identity requires a configured client ID');
  const login = `${slug}[bot]`;
  const bot = lookup(login);
  assert(bot.type === 'Bot' && bot.login === login && Number.isSafeInteger(bot.id) && bot.id > 0,
    'Unexpected release bot identity');
  return bot;
}

