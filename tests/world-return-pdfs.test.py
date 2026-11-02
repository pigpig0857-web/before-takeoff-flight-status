"""Independently transcribed expected published daily PDF/DOM schedules."""
import json
from datetime import date,timedelta
from pathlib import Path
root=Path('data/source-samples/crawler/return-world-20261019/verified')
for folder in ('PR-latest','GK-latest','NU'):
    actual=json.loads((root/folder/'candidate-flights.json').read_text(encoding='utf8'))['records']
    expected=set()
    for i in range(74):
        day=date(2026,10,19)+timedelta(days=i);summer=day<date(2026,10,25)
        if folder=='PR-latest':
            flights=[('MNL','TPE','PR890','06:30' if summer else '06:45','08:45' if summer else '09:00')]
            if summer:
                flights.append(('MNL','TPE','PR896','12:35','15:05') if day.weekday() in (0,1,5) else ('MNL','TPE','PR894','18:25','20:50'))
            else:flights.append(('MNL','TPE','PR894','18:40','20:55'))
        elif folder=='GK-latest':
            flights=[('NRT','TPE','GK13','09:15' if summer else '08:30','12:10' if summer else '11:50'),('NRT','TPE','GK11','22:40' if summer else '22:25','01:30'),('NRT','KHH','GK17','09:55' if summer else '09:25','13:00'),('KIX','TPE','GK55','15:20' if summer else '14:55','17:20' if summer else '17:15')]
            if summer:flights.append(('KIX','TPE','GK57','23:35','01:30'))
            if day in [date(2026,12,x) for x in (26,28,29,31)]:flights.append(('NRT','TPE','GK15','12:35' if day.day==29 else '12:30','15:50' if day.day==29 else '15:45'))
            if day>=date(2026,12,6) and day.isoweekday() in (3,5,7):flights.append(('OKA','KHH','GK97','12:40','13:35'))
        else:
            flights=[('OKA','TPE','NU301','08:30' if summer or day.month==12 else '08:35','09:05' if summer else '09:15')]
            if not summer or day==date(2026,10,24):flights.append(('OKA','TPE','NU307','18:05' if summer else '17:55','18:40'))
        expected.update((str(day),a,b,n,d,t) for a,b,n,d,t in flights)
    result={(r['date'],r['departureAirport'],r['arrivalAirport'],r['number'],r['departure'][11:16],r['arrival'][11:16]) for r in actual}
    assert result==expected,dict(folder=folder,missing=sorted(expected-result),unexpected=sorted(result-expected))
    assert len(result)==len(actual)
    report=dict(status='passed',records=len(actual),method='Independent daily oracle transcribed from visually reviewed sources',winterGk57ExcludedForMalformedValidity=folder=='GK-latest')
    (root/folder/'daily-oracle-audit.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(folder,len(actual),'daily schedules matched')
