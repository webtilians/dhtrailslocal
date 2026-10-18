"""Signs that a time trial GPS file was edited or copied.

None of them proves cheating, so an entry that shows any waits for the organizer («En revisión»)
instead of entering the standings at once; the organizer sees why and decides. The thresholds come
from the riders' own recordings (Strava exports of 30 runs on 9 circuits): every interval between
fixes was a whole second, and no run kept its speed steadier than 13 % (variation over 3 s).
"""
import math
import re
import statistics
import time
from bisect import bisect_left, bisect_right
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config
from .models import Activity, Attempt, Pilot
from .timing import haversine

# Programs that create or edit tracks (by the name they write in the file), not watches or apps that record.
EDITORS={"gpx.studio":"gpx.studio","gpsvisualizer":"GPS Visualizer","gps visualizer":"GPS Visualizer",
         "gotoes":"GOTOES","gpx editor":"GPX Editor","gpxeditor":"GPX Editor","routeconverter":"RouteConverter",
         "viking":"Viking","gpsbabel":"GPSBabel","josm":"JOSM","qgis":"QGIS","gps track editor":"GPS Track Editor",
         "basecamp":"BaseCamp","plotaroute":"plotaroute"}
FRACTIONAL_SHARE=0.2  # intervals between fixes that are not whole seconds: 0 % in real recordings
STEADY_CV=0.06        # speed variation over 3 s below this looks generated: 13 % at least in real runs
SAME_POINT_M=0.5      # two different recordings never put most of their fixes this close
SAME_SHARE=0.8
FUTURE_MS=10*60*1000

def _metres(a,b)->float:
    rad=math.pi/180
    return 6371000*math.hypot((b[1]-a[1])*rad*math.cos((a[0]+b[0])/2*rad),(b[0]-a[0])*rad)

def _day(moment)->str:
    return moment.astimezone(ZoneInfo(config.COMPETITION_TIMEZONE)).strftime("%d/%m/%Y") if moment else "—"

def editor_sign(data:bytes)->str|None:
    """The program the file says made it, when it is one that edits tracks."""
    head=data[:8192].decode("utf-8","replace")
    told=" ".join(re.findall(r'creator\s*=\s*"([^"]*)"',head)+re.findall(r"<metadata>(.*?)</metadata>",head,re.S)
                  +re.findall(r"<Creator\b(.*?)</Creator>",head,re.S)).lower()
    for key,name in EDITORS.items():
        if key in told:return f"el archivo dice que lo creó o editó {name}, un programa para editar rutas"
    return None

def time_signs(fixes,run)->list[str]:
    """Hours edited by hand or by a program: odd intervals, or a speed no rider keeps on a trail."""
    seg=[f for f in fixes[run.start_index:run.finish_index+1] if f.time is not None]
    steps=[(b.time-a.time)/1000 for a,b in zip(seg,seg[1:]) if b.time>a.time]
    signs=[]
    if steps:
        odd=sum(1 for s in steps if abs(s-round(s))>0.05)/len(steps)
        if odd>FRACTIONAL_SHARE:
            signs.append(f"el {round(odd*100)} % de los intervalos entre puntos no son segundos enteros, "
                         "algo que los relojes y móviles no hacen y sí pasa al cambiar las horas")
    speeds=[sum(haversine(a,b) for a,b in zip(seg[i:i+3],seg[i+1:i+4]))/((seg[i+3].time-seg[i].time)/1000)
            for i in range(len(seg)-3) if seg[i+3].time>seg[i].time]
    if len(speeds)>=20:
        mean=statistics.fmean(speeds)
        if mean>0 and statistics.pstdev(speeds)/mean<STEADY_CV:
            signs.append("la velocidad es casi la misma en toda la bajada, como en una ruta generada con un programa")
    if run.started_ms and run.started_ms>time.time()*1000+FUTURE_MS:
        signs.append("la bajada tiene fecha y hora futuras")
    return signs

def same_track(mine:list,theirs:list)->bool:
    """Most fixes of one run on top of the other's (within half a metre): a copy, not a second recording."""
    if not mine or not theirs or len(mine)<10 or len(theirs)<10:return False
    pts=sorted(theirs)
    along=[p[0] for p in pts]
    close=0
    for s,_,lat,lon in mine:
        near=pts[bisect_left(along,s-20):bisect_right(along,s+20)]
        if any(_metres((lat,lon),(q[2],q[3]))<=SAME_POINT_M for q in near):close+=1
    return close>=SAME_SHARE*len(mine)

def copy_signs(db:Session,pilot_id,digest:str,profile:list|None,elapsed_ms:int,circuit_id,exclude_id=None)->list[str]:
    """The same file from another rider, or the same track as another run with another time."""
    signs=[]
    other=db.execute(select(Pilot.display_name).join(Activity,Activity.owner_id==Pilot.id)
                     .where(Activity.sha256==digest,Activity.owner_id!=pilot_id).limit(1)).first()
    if other:signs.append(f"el mismo archivo GPS lo subió otro piloto ({other[0] or 'sin nombre'})")
    if not profile:return signs
    rows=db.execute(select(Attempt,Pilot.display_name).join(Pilot,Pilot.id==Attempt.pilot_id)
                    .where(Attempt.circuit_id==circuit_id,Attempt.profile.is_not(None),
                           *([Attempt.id!=exclude_id] if exclude_id else []))).all()
    theirs=mine=False
    for a,name in rows:
        if (theirs if a.pilot_id!=pilot_id else mine) or not same_track(profile,a.profile):continue
        if a.pilot_id!=pilot_id:
            theirs=True
            signs.append(f"la misma ruta, punto por punto, que una bajada de {name or 'otro piloto'} del {_day(a.started_at)}")
        elif a.elapsed_ms is not None and abs(a.elapsed_ms-elapsed_ms)>=1000:
            # The same ride sent to training and to the tournament has the same time: only another time is odd.
            mine=True
            signs.append(f"la misma ruta, punto por punto, que otra bajada suya del {_day(a.started_at)} "
                         f"pero con otro tiempo ({a.elapsed_ms/1000:.1f} s)")
    return signs

def integrity_checks(db:Session,pilot_id,data:bytes,fixes,run,digest:str,circuit_id,exclude_id=None)->list[str]:
    signs=[]
    editor=editor_sign(data)
    if editor:signs.append(editor)
    signs+=time_signs(fixes,run)
    signs+=copy_signs(db,pilot_id,digest,run.profile,round(run.seconds*1000),circuit_id,exclude_id)
    return signs
