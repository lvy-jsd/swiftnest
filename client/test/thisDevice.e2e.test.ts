/** Native UI bridge contract test. Rust↔Nest behavior is exercised separately by native/perch/test. */
import { launchChromium } from './browser';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, extname, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')('This device: desktop bridge consent, folder picker, bilingual phone layout, disable/unpair, Android/web hidden', async () => {
  const browser = await launchChromium();
  const dist=resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
  const server=createServer(async (req,res)=>{
    try {
      const pathname=new URL(req.url!,'http://localhost').pathname;
      const path=pathname==='/'?join(dist,'index.html'):resolve(dist,`.${pathname}`);
      if (!path.startsWith(dist+sep)) { res.writeHead(404).end(); return; }
      const data=await readFile(path); res.setHeader('content-type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html'); res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/#/devices`;
  try {
    for (const locale of ['en-US','zh-CN']) {
      const page=await browser.newPage({viewport:{width:390,height:844},locale});
      await page.addInitScript((lang) => localStorage.setItem('swiftnest.locale', lang), locale === 'en-US' ? 'en' : 'zh-CN');
      await page.addInitScript(()=>{
        let value:any={settings:{name:'This computer',slug:'computer-fixed',enabled:false,background:false,roots:[],url:'ws://server:7711/swiftnest',nestKey:null},phase:'stopped',fingerprint:'aaaa-bbbb-cccc-dddd',nestFingerprint:null,confirmationPending:false,error:null,platform:'desktop'};
        (window as any).__deviceTest={calls:[],setPlatform:(platform:string)=>{value.platform=platform;}};
        (window as any).__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
          (window as any).__deviceTest.calls.push({command,args});
          if(command==='phone_status')return {accessibility:true,notifications:false};
          if(command==='perch_pick_folders')return ['/home/owner/Shared folder with a deliberately very long name/notes'];
          if(command==='perch_configure'){
            value.settings={...args.settings,nestKey:value.settings.nestKey};value.phase=args.settings.enabled?'online':'stopped';
            if(args.code){value.phase='confirming';value.nestFingerprint='1111-2222-3333-4444';value.confirmationPending=true;}
          }
          if(command==='perch_confirm'){value.confirmationPending=false;value.phase=args.accept?'online':'stopped';value.settings.nestKey=args.accept?'public-nest-key':null;value.nestFingerprint=null;}
          if(command==='perch_disable'){value.settings.enabled=false;value.phase='stopped';}
          if(command==='perch_unpair'){value.settings.enabled=false;value.settings.nestKey=null;value.phase='stopped';}
          return structuredClone(value);
        }};
      });
      await page.goto(url);
      const zh=locale==='zh-CN';
      const section=page.locator('.this-device');await section.waitFor();
      const toggle=section.getByRole('checkbox',{name:zh?'允许 Ivy 控制这台电脑':'Let Ivy control this computer',exact:true});
      expect(await toggle.isChecked()).toBe(false);expect(await toggle.isDisabled()).toBe(true);
      await section.getByRole('button',{name:zh?'添加共享文件夹':'Add shared folder',exact:true}).click();
      await section.getByLabel(zh?'设备显示名称':'Device display name',{exact:true}).fill('My laptop');
      await section.getByLabel(zh?'配对码':'Pairing code',{exact:true}).fill('123456');
      await section.getByRole('button',{name:zh?'配对这台电脑':'Pair this computer',exact:true}).click();
      await section.getByText('1111-2222-3333-4444',{exact:true}).waitFor();
      const before=await page.evaluate(()=>(window as any).__deviceTest.calls.filter((c:any)=>c.command==='perch_confirm'));
      expect(before).toHaveLength(0);
      await section.getByRole('button',{name:zh?'指纹一致':'Fingerprint matches',exact:true}).click();
      await expect.poll(()=>toggle.isChecked()).toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      // Unsaved invalid edits must never prevent the emergency off action.
      await section.getByLabel(zh?'设备显示名称':'Device display name',{exact:true}).fill('');
      await toggle.click();
      await expect.poll(()=>toggle.isChecked()).toBe(false);
      await section.getByLabel(zh?'设备显示名称':'Device display name',{exact:true}).fill('My laptop');
      await section.getByRole('checkbox',{name:zh?'在后台保持运行':'Keep running in the background'}).check();
      await section.getByRole('button',{name:zh?'保存':'Save',exact:true}).click();
      await expect.poll(()=>page.evaluate(()=>(window as any).__deviceTest.calls.filter((c:any)=>c.command==='perch_configure').at(-1)?.args.settings.background)).toBe(true);
      await section.getByRole('button',{name:zh?'取消此电脑配对':'Unpair this computer',exact:true}).click();
      await page.getByRole('dialog').getByRole('button',{name:zh?'取消此电脑配对':'Unpair this computer',exact:true}).click();
      await section.getByRole('button',{name:zh?'配对这台电脑':'Pair this computer',exact:true}).waitFor();
      // Android shows the phone variant: permissions instead of folders, live view and background.
      await page.evaluate(()=>(window as any).__deviceTest.setPlatform('android'));
      await section.getByRole('checkbox',{name:zh?'允许 Ivy 使用这台手机':'Let Ivy use this phone'}).waitFor();
      await section.getByText(zh?'无障碍':'Accessibility',{exact:true}).waitFor();
      await section.getByText(zh?'· 已开启':'· On').first().waitFor();
      await section.getByText(zh?'· 未开启':'· Off').first().waitFor();
      expect(await section.getByRole('button',{name:zh?'添加共享文件夹':'Add shared folder'}).count()).toBe(0);
      expect(await section.getByRole('checkbox',{name:zh?'允许实时画面':'Allow live view'}).count()).toBe(0);
      await section.getByRole('button',{name:zh?'打开系统设置':'Open system settings'}).first().click();
      await expect.poll(()=>page.evaluate(()=>(window as any).__deviceTest.calls.some((c:any)=>c.command==='phone_open_settings'&&c.args.kind==='accessibility'))).toBe(true);
      await page.evaluate(()=>(window as any).__deviceTest.setPlatform('ios'));
      await expect.poll(()=>section.count(), { timeout:5000 }).toBe(0);
      await page.close();
    }
    const web=await browser.newPage({locale:"zh-CN"});await web.goto(url);expect(await web.locator('.this-device').count()).toBe(0);await web.close();
  } finally {await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
},30000);
