"""Inspect saved public page controls; never executes website scripts or requests data."""
import json, re, sys
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

class Surface(HTMLParser):
    def __init__(self):
        super().__init__(); self.controls=[]; self.links=[]; self.scripts=[]; self.forms=[]; self.select=None; self.option=None; self.anchor=None
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='form': self.forms.append({k:a.get(k) for k in ['action','method','id']})
        if tag=='script' and a.get('src'): self.scripts.append(a['src'])
        if tag in ['input','select']:
            c={k:a.get(k) for k in ['name','id','type']};c['tag']=tag
            if tag=='select': c['options']=[];self.select=c
            self.controls.append(c)
        if tag=='option' and self.select is not None: self.option={'value':a.get('value'),'label':''};self.select['options'].append(self.option)
        if tag=='a' and a.get('href'): self.anchor={'href':a['href'],'label':''};self.links.append(self.anchor)
    def handle_data(self,text):
        if self.option is not None:self.option['label']+=text.strip()
        if self.anchor is not None:self.anchor['label']+=text.strip()
    def handle_endtag(self,tag):
        if tag=='option':self.option=None
        if tag=='select':self.select=None
        if tag=='a':self.anchor=None

root=Path(sys.argv[1]);out={}
for name in ['peach-timetable','peach-status','caa-open-data','caa-foreign-schedule']:
    html=(root/(name+'.html')).read_text(encoding='utf8');p=Surface();p.feed(html)
    result={'forms':p.forms,'controls':p.controls,'scripts':p.scripts,'links':p.links}
    out[name]=result
    print(name)
    print('Forms:',p.forms)
    print('Scripts:',[s for s in p.scripts if re.search('flight|status|schedule|regular',s,re.I)])
    print('Controls:',[{**c,'options':c.get('options',[])[:8],'optionCount':len(c.get('options',[]))} for c in p.controls if re.search('date|year|month|flight|airport|airline|route',str(c['id'])+str(c['name']),re.I)])
    print('Links:',[a for a in p.links if re.search('csv|download',a['href'],re.I)][-12:])
(root/'surface-inspection.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
