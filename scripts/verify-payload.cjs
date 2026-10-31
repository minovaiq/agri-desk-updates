const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const {createHash}=require('node:crypto');
const {gunzipSync}=require('node:zlib');
const path=require('node:path');
const yaml=require('js-yaml');
(async()=>{
 const [directory,version]=process.argv.slice(2);
 if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version');
 const name=`Agri-Desk-Setup-${version}-x64.exe`,file=path.join(directory,name),meta=yaml.load(await fs.readFile(path.join(directory,'latest.yml'),'utf8'));
 if(meta.version!==version||meta.path!==name||meta.files?.length!==1||meta.files[0].url!==name)throw Error('Manifest does not match the release tag and installer');
 const h=await fs.open(file),header=Buffer.alloc(2);try{await h.read(header,0,2,0);}finally{await h.close();}
 if(header[0]!==77||header[1]!==90)throw Error('Installer is not a Windows executable');
 const hash=createHash('sha512');for await(const part of createReadStream(file))hash.update(part);
 const checksum=hash.digest('base64'),size=(await fs.stat(file)).size;
 if(meta.sha512!==checksum||meta.files[0].sha512!==checksum||meta.files[0].size!==size)throw Error('Checksum or installer size mismatch');
 const map=JSON.parse(gunzipSync(await fs.readFile(file+'.blockmap'),{maxOutputLength:8*1024*1024}).toString());
 if(!map.version||!Array.isArray(map.files)||!map.files.length)throw Error('Invalid differential blockmap');
 console.log(JSON.stringify({version,installer:name,size,verified:true}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
