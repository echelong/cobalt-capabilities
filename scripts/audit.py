#!/usr/bin/env python3
"""Read-only public release checks. Prints locations, never credential values."""
from pathlib import Path
import json, re, struct, sys
root = Path(__file__).resolve().parents[1]
private = re.compile(r'/home/' + ''.join(map(chr, [114,105,111])) + r'\b|\b' + ''.join(map(chr, [114,105,111])) + r'\b|\b(?:' + '|'.join([''.join(map(chr,x)) for x in ([67,76,73,78,67,72],[69,110,101,114,98,105,100],[78,97,100,100,111])]) + r')\b', re.I)
credential = re.compile(r'\b(?:sk-ant-|sk_live_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b')
# A directory scanner refuses a source file that carries an invisible format
# character, however harmless it is: it cannot be reviewed, and it can hide a
# different name under a look-alike one. Tab, newline and carriage return are
# the whitespace every file may hold; nothing else in this class is allowed.
format_char = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\xad\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]')
findings=[]; count=0; total=0
for p in sorted(root.rglob('*')):
 rel=p.relative_to(root)
 if '.git' in rel.parts or 'node_modules' in rel.parts or '__pycache__' in rel.parts: continue
 # The engine's own declarations, written into the plugin folder on a
 # development load and gitignored here: not this repository's files.
 if rel.parts[:2]==('.claude-plugin','types'): continue
 # A checkout of Cobalt Cockpit for the cross-plugin tests: gitignored, audited
 # in its own repository.
 if rel.parts[:1]==('.cockpit',): continue
 if p.is_symlink(): findings.append(f'{rel}: symbolic link'); continue
 if not p.is_file(): continue
 count+=1; total+=p.stat().st_size
 if p.stat().st_size>5*1024*1024: findings.append(f'{rel}: exceeds file limit')
 if p.name in ('AGENTS.md','CLAUDE.md','.DS_Store','Thumbs.db'): findings.append(f'{rel}: excluded release file')
 data=p.read_bytes()
 try: text=data.decode('utf8')
 except UnicodeDecodeError:
  findings.append(f'{rel}: unexpected binary')
  continue
 for n,line in enumerate(text.splitlines(),1):
  if private.search(line): findings.append(f'{rel}:{n}: personal reference')
  if credential.search(line): findings.append(f'{rel}:{n}: credential-like value (review synthetic fixtures)')
  if format_char.search(line): findings.append(f'{rel}:{n}: unescaped format or control character')
# The hooks module, as a directory scanner reads it: no file is loaded while the
# mod runs, nothing is evaluated, and every hook that can refuse has a handler.
for p in sorted((root/'hooks').glob('*.ts*')):
 source=p.read_text()
 for n,line in enumerate(source.splitlines(),1):
  if re.search(r'\bimport\s*\(', line): findings.append(f'hooks/{p.name}:{n}: import() expression; use a static import at the top of the file')
  if re.search(r'\beval\s*\(|new\s+Function\s*\(', line): findings.append(f'hooks/{p.name}:{n}: dynamic evaluation')
 for head in ("on('tool.call'", "on('agent.spawn'", "on('command.run'"):
  for start in [m.start() for m in re.finditer(re.escape(head), source)]:
   nxt=min([i for i in (source.find("\n  on('", start+1), len(source)) if i>0])
   if '.catch(' not in source[start:nxt]: findings.append(f'hooks/{p.name}: {head} registered without a .catch handler')
# One release, one version: the manifest, the marketplace entry, the npm manifest
# and its lockfile all name it; both capabilities default off; nothing is installed
# for the user and no locked package runs an install script.
m=json.loads((root/'.claude-plugin/plugin.json').read_text()); market=json.loads((root/'.claude-plugin/marketplace.json').read_text())
package=json.loads((root/'capabilities/package.json').read_text()); lock=json.loads((root/'capabilities/package-lock.json').read_text())
assert m['name']==market['name']==market['plugins'][0]['name']=='cobalt-capabilities'
assert len(market['plugins'])==1 and market['plugins'][0]['source']=='./'
assert m['version']==market['plugins'][0]['version']==package['version']==lock['version']==lock['packages']['']['version']
assert re.fullmatch(r'\d+\.\d+\.\d+', m['version']), m['version']
assert m['repository']=='https://github.com/echelong/cobalt-capabilities'
assert m['license']=='MIT'
for key in ('memoryEnabled','browserEnabled'):
 assert m['userConfig'][key]['default'] is False, key
assert m['userConfig']['configurationPath']['default']==''
assert package.get('dependencies') is None and package.get('scripts',{}).keys()<={'test:browser'}
assert list(package['optionalDependencies'])==['puppeteer-core'] and re.fullmatch(r'\d+\.\d+\.\d+', package['optionalDependencies']['puppeteer-core']), 'the browser dependency is pinned exactly'
for name, entry in lock['packages'].items():
 if not name: continue
 assert entry['resolved'].startswith('https://registry.npmjs.org/') and entry['integrity'].startswith('sha512-'), name
 assert not entry.get('hasInstallScript'), f'{name} declares an install script'
# No package manifest at the plugin root: nothing is installed when the plugin is.
assert not (root/'package.json').exists() and not (root/'package-lock.json').exists()
example=json.loads((root/'config.example.json').read_text())
for key in ('memory_enabled','browser_enabled','memory_retention_consent','memory_inference_configured','browser_allow_localhost','browser_isolation_confirmed'):
 assert example[key] is False, key
assert example['memory_repositories']==[] and example['browser_allowed_origins']==[] and example['browser_authorized_actions']==[] and example['screenshot_retention']=='none'
assert example['browser_egress_proxy'].startswith('http://127.0.0.1:')
for name in ('README.md','LICENSE','THIRD_PARTY_NOTICES','SECURITY.md','PRIVACY.md','CHANGELOG.md','.gitignore'):
 assert (root/name).is_file(), name
notices=(root/'THIRD_PARTY_NOTICES').read_text()
for name, entry in lock['packages'].items():
 if name: assert f"{name.replace('node_modules/','')} {entry['version']}  {entry['license']}" in notices, f'THIRD_PARTY_NOTICES is missing {name}'
assert f"## {m['version']} " in (root/'CHANGELOG.md').read_text(), 'CHANGELOG has no entry for this version'
# The browser worker loads its one dependency by a path it has checked, and
# nothing else dynamically.
worker=(root/'capabilities/browser.mjs').read_text()
assert len(re.findall(r'\bimport\s*\(', worker))==1 and 'await import(resolved)' in worker
assert not re.search(r'\bimport\s*\(', (root/'capabilities/egress.mjs').read_text())
print(f'{count} files; {total} bytes; manifest/defaults/lockfile/notice checks passed')
print(f'{len(findings)} portability/credential findings')
for finding in findings: print(finding)
sys.exit(1 if findings else 0)
