// After npm install: the GPS plugin's iPhone side asks for its finest mode (the GPS helped by the motion
// sensors, «BestForNavigation») only while the phone is charging; a ride needs it always. It also tells iOS
// the GPS is for a sport (activityType .fitness), never snapped to roads. The plugin has no option for
// either, so its source is changed here; if a new version changes those lines, this stops the build.
import {readFileSync, writeFileSync} from 'node:fs';

const file = new URL('../node_modules/@capacitor-community/background-geolocation/ios/Plugin/Swift/Plugin.swift', import.meta.url);
const MARK = '// DH Trails: always the finest GPS';
const source = readFileSync(file, 'utf8');
if (source.includes(MARK)) process.exit(0);
const original = /( *)let externalPower = \[\s*\.full,\s*\.charging\s*\]\.contains\(UIDevice\.current\.batteryState\)\s*manager\.desiredAccuracy = \(\s*externalPower\s*\? kCLLocationAccuracyBestForNavigation\s*: kCLLocationAccuracyBest\s*\)/;
const found = source.match(original);
if (!found) {
  console.error('patch-gps: the GPS plugin changed; check movil/scripts/patch-gps.mjs');
  process.exit(1);
}
const indent = found[1];
writeFileSync(file, source.replace(original, `${indent}${MARK} (with the motion sensors), charging or not\n` +
  `${indent}manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation\n${indent}manager.activityType = .fitness`));
console.log('patch-gps: iPhone GPS set to BestForNavigation and fitness');
