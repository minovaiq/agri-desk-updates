const fs=require('node:fs/promises');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const repo='minovaiq/agri-desk-updates';
function validateRequest(value){
 if(!value||!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value.tag))throw Error('Invalid stable release tag');
 if(value.state==='published')return null;
 if(value.bundle!==`Agri-Desk-Release-${value.tag}.zip`||!/^[a-f0-9]{64}$/.test(value.sha256)||!/^[a-f0-9]{40}$/.test(value.source_commit))throw Error('Invalid compiled bundle request');
 const url=new URL(value.source_url);
 if(url.protocol!=='https:'||url.hostname!=='release-assets.githubusercontent.com'||url.port||url.username||url.password||!url.pathname.startsWith('/github-production-release-asset/1440655600/'))throw Error('Bundle must come from the Agri Desk release assets');
 if(typeof value.notes!=='string'||value.notes.length>6000||typeof value.title!=='string'||value.title.length>200)throw Error('Invalid release notes');
 return {...value,source_url:url.href};
}
function compareTags(a,b){
 const parse=t=>{if(!/^v\d+\.\d+\.\d+$/.test(t))throw Error('Invalid existing release tag');return t.slice(1).split('.').map(BigInt);};
 const x=parse(a),y=parse(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;
}
function run(command,args,options={}){
 const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:4*1024*1024,...options});
 if(r.error)throw r.error;
 if(r.status!==0&&!options.allowFailure)throw Error((r.stderr||r.stdout||`${command} failed`).trim());
 return r;
}
async function main(){
 if(process.env.GITHUB_REPOSITORY!==repo||!process.env.GH_TOKEN)throw Error('Unexpected public release context');
 const requestBytes=await fs.readFile('release-request.json');
 if(requestBytes.length>20000)throw Error('Release request is too large');
 const request=validateRequest(JSON.parse(requestBytes));
 if(!request){console.log('This release request is already published.');return;}
 const latest=run('gh',['release','view','--repo',repo,'--json','tagName'],{allowFailure:true});
 if(latest.status===0&&compareTags(request.tag,JSON.parse(latest.stdout).tagName)<=0)throw Error('A published release must never be overwritten or downgraded');
 if(latest.status!==0&&!/release not found|404/i.test(latest.stderr))throw Error('Could not verify the latest published version');
 const existing=run('gh',['release','view',request.tag,'--repo',repo,'--json','isDraft'],{allowFailure:true});
 if(existing.status===0&&!JSON.parse(existing.stdout).isDraft)throw Error('The destination tag is already published');
 if(existing.status!==0&&!/release not found|404/i.test(existing.stderr))throw Error('Could not verify the destination release');
 const incoming=path.resolve('.release-incoming');await fs.mkdir(incoming,{recursive:true});
 const bundle=path.join(incoming,'bundle.zip');
 const response=await fetch(request.source_url,{redirect:'manual',signal:AbortSignal.timeout(120000)});
 if(response.status!==200)throw Error(`Could not download the compiled bundle (${response.status}); refresh its temporary link`);
 const file=await fs.open(bundle,'w'),hash=createHash('sha256');let bytes=0;
 try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>650*1024*1024)throw Error('Compiled bundle is too large');hash.update(chunk);await file.write(chunk);}}finally{await file.close();}
 if(hash.digest('hex')!==request.sha256)throw Error('Compiled bundle checksum differs from the verified Windows build');
 const payload=path.join(incoming,'payload');
 const extract=String.raw`import pathlib,sys,zipfile
bundle,directory,tag=sys.argv[1:]
name='Agri-Desk-Setup-'+tag[1:]+'-x64.exe'
expected={name,name+'.blockmap','latest.yml'}
with zipfile.ZipFile(bundle) as z:
 if len(z.namelist())!=3 or set(z.namelist())!=expected: raise ValueError('Unexpected bundle files')
 if sum(i.file_size for i in z.infolist())>650*1024*1024: raise ValueError('Expanded bundle is too large')
 if z.testzip() is not None: raise ValueError('Corrupt bundle')
 pathlib.Path(directory).mkdir()
 z.extractall(directory)
`;
 run('python',['-c',extract,bundle,payload,request.tag]);
 run(process.execPath,['scripts/verify-payload.cjs',payload,request.tag.slice(1)]);
 const notes=path.join(incoming,'notes.md');await fs.writeFile(notes,request.notes);
 if(existing.status!==0)run('gh',['release','create',request.tag,'--repo',repo,'--target',process.env.GITHUB_SHA,'--draft','--title',request.title,'--notes-file',notes]);
 else run('gh',['release','edit',request.tag,'--repo',repo,'--title',request.title,'--notes-file',notes]);
 const name=`Agri-Desk-Setup-${request.tag.slice(1)}-x64.exe`,namedBundle=path.join(incoming,request.bundle);
 await fs.rename(bundle,namedBundle);
 run('gh',['release','upload',request.tag,'--repo',repo,path.join(payload,name),path.join(payload,name+'.blockmap'),path.join(payload,'latest.yml'),namedBundle,'--clobber']);
 run('gh',['release','edit',request.tag,'--repo',repo,'--draft=false','--latest']);
 const releaseUrl=`https://github.com/${repo}/releases/tag/${request.tag}`;
 const published={tag:request.tag,state:'published',sha256:request.sha256,source_commit:request.source_commit,release_url:releaseUrl};
 const sha=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${requestBytes.length}\0`),requestBytes])).digest('hex');
 const cleanup=run('gh',['api','--method','PUT',`repos/${repo}/contents/release-request.json`,'--input','-'],{allowFailure:true,input:JSON.stringify({message:`Record published ${request.tag} [skip ci]`,sha,content:Buffer.from(JSON.stringify(published,null,2)+'\n').toString('base64')})});
 if(cleanup.status!==0)console.warn('The release is published; a newer request prevented temporary-link cleanup.');
 console.log(`Published ${request.tag} after validating the installer, blockmap and metadata.`);
}
module.exports={validateRequest,compareTags};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
