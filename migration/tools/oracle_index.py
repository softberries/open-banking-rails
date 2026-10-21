import json,os,sys
D=sys.argv[1]
idx={}
for f in sorted(os.listdir(D+'/oracle/http')):
    d=json.load(open(D+'/oracle/http/'+f))
    verb,route=d['route'].split(' ',1)
    path=route.replace('(.:format)','').replace('(.json)','')
    if not path.startswith('/api/:version/docs'): path=path.replace('/api/:version','/api/v1')
    key='MOUNT /sidekiq' if path=='/sidekiq' else f'{verb} {path}'
    idx.setdefault(key,[]).append({'file':'oracle/http/'+f,'cases':[f"{c['case']} -> {c['response']['status']}" for c in d['cases']]})
json.dump(idx,open(D+'/oracle/index.json','w'),indent=1)
keys=json.load(open(D+'/inventory/coverage_keys.json'))
print(len(idx),'oracle keys; routes without sample:',[k for k in keys['routes'] if k not in idx],'; extra:',[k for k in idx if k not in keys['routes']])
