import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile,readFile,readdir} from 'node:fs/promises';
const root='/receipt';
if(process.argv[2]==='download') {
 const response=await fetch('https://registry.npmjs.org/@duetso%2fagent/0.3.29');
 assert.equal(response.status,200);
 const metadata=await response.json();
 assert.equal(metadata.name,'@duetso/agent'); assert.equal(metadata.version,'0.3.29');
 assert.equal(metadata.dist.integrity,'sha512-FSgTO2mBVc7rB/4Aa9sB0I8M4e1QQgcWF050R8L5hm7S8hJHQ2zqDYJaXgJT+1EDPUUmrkC9jBZN7v/Py1oHgw==');
 assert.equal(metadata.dist.shasum,'dd1f7e1b1ef028f79b7a82f2d96c2d1b1bd36acd');
 assert.equal(metadata.gitHead,'a8676bc7f10fece825b4e82bd2d65d6dcdd0e072');
 const blob=Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
 const integrity='sha512-'+createHash('sha512').update(blob).digest('base64');
 assert.equal(integrity,metadata.dist.integrity);
 const shasum=createHash('sha1').update(blob).digest('hex');assert.equal(shasum,metadata.dist.shasum);
 await writeFile(root+'/agent-0.3.29.tgz',blob);
 await writeFile(root+'/provenance.json',JSON.stringify({version:metadata.version,gitHead:metadata.gitHead,integrity,shasum,tarball:metadata.dist.tarball,bytes:blob.length,integrityVerified:true},null,2));
} else {
 let files=0;
 async function compare(relative='') {
  for(const entry of await readdir('/tmp/expected/package/'+relative,{withFileTypes:true})) {
   const name=relative+entry.name;
   if(entry.isDirectory()) await compare(name+'/');
   else if(entry.isFile()) {assert.deepEqual(await readFile('/tmp/expected/package/'+name),await readFile('/work/node_modules/@duetso/agent/'+name),name);files++;}
  }
 }
 await compare();
 const receipt=JSON.parse(await readFile(root+'/provenance.json','utf8'));
 await writeFile(root+'/provenance.json',JSON.stringify({...receipt,installedFilesVerified:files,installedBytesMatchRegistryTarball:true},null,2));
 console.log(JSON.stringify({installedFilesVerified:files,installedBytesMatchRegistryTarball:true}));
}
