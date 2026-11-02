import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startDevices, ADMIN_TOKEN_ENV, ADMIN_URL_ENV } from '../src/devices';
it('uses config then environment for CLI language; Chinese is the default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-lang-config-'));
  try {
    const config = join(home, 'config.yml'); await writeFile(config, 'lang: en\n');
    expect(loadConfig(undefined, {}).lang).toBe('zh-CN');
    expect(loadConfig(config, {}).lang).toBe('en');
    expect(loadConfig(config, {SWIFTNEST_LANG:'zh-CN'}).lang).toBe('zh-CN');
  } finally { await rm(home,{recursive:true,force:true}); }
});
it('authenticates language changes, shares them between callers and persists them across restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-lang-'));
  const config = loadConfig(undefined, { SWIFTNEST_HOME:home, SWIFTNEST_DEVICES_PORT:'0', SWIFTNEST_DEVICES_MDNS:'false' });
  let hub = await startDevices(config);
  const request = (path='/preferences', body?: unknown, token=hub.env[ADMIN_TOKEN_ENV]) => fetch(hub.env[ADMIN_URL_ENV]+'/swiftnest/api/devices'+path, {method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try {
    expect(await (await request()).json()).toEqual({lang:'zh-CN'});
    expect((await request('/preferences',{lang:'en'},'bad')).status).toBe(401);
    expect((await request('/preferences',{lang:'fr'})).status).toBe(400);
    expect((await request('/preferences',{lang:'en',padding:'x'.repeat(1024)})).status).toBe(413);
    const before = await (await request('/missing')).json();
    expect(before).toMatchObject({message:'未找到请求的内容',hint:expect.any(String),code:expect.any(String)});
    expect(await (await request('/preferences',{lang:'en'})).json()).toEqual({lang:'en'});
    expect(await (await request()).json()).toEqual({lang:'en'});
    const after = await (await request('/missing')).json();
    expect(after.code).toBe(before.code); expect(after.message).toBe('Not found');
    await hub.close(); hub=await startDevices(config);
    expect(await (await request()).json()).toEqual({lang:'en'});
    await Promise.all([request('/preferences',{lang:'zh-CN'}),request('/preferences',{lang:'en'})]);
    expect(['en','zh-CN']).toContain((await (await request()).json()).lang);
  } finally { await hub.close(); await rm(home,{recursive:true,force:true}); }
});

it('includes the configured assistant name with the preferences', async () => {
  const home = await mkdtemp(join(tmpdir(), 'swiftnest-name-'));
  const env = { SWIFTNEST_HOME: home, SWIFTNEST_DEVICES_PORT: '0', SWIFTNEST_DEVICES_MDNS: 'false', SWIFTNEST_ASSISTANT_NAME: '小艾' };
  const hub = await startDevices(loadConfig(undefined, env));
  try {
    const response = await fetch(hub.env[ADMIN_URL_ENV] + '/swiftnest/api/devices/preferences', {
      headers: { authorization: `Bearer ${hub.env[ADMIN_TOKEN_ENV]}` },
    });
    expect(await response.json()).toEqual({ lang: 'zh-CN', assistantName: '小艾' });
  } finally {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});
