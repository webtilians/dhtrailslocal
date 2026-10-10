import test from 'node:test';
import assert from 'node:assert/strict';
import {lineChart} from '../charts.mjs';

// Only the DOM surface needed to exercise the chart's real event handlers.
class Element {
  constructor(tag) {this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.style = {}; this.clientWidth = 600;}
  setAttribute(k, v) {this.attrs[k] = String(v);}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children = children;}
  addEventListener(type, handler) {this.events[type] = handler;}
  getBoundingClientRect() {return {left: 100, width: 300};}
}

test('chart clicks respect SVG scaling, persist after hover, sync and clear; keyboard reaches endpoints', () => {
  const previous = globalThis.document;
  globalThis.document = {createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag)};
  try {
    const host = new Element('div'), selected = [];
    const chart = lineChart(host, {series: [{label: 'Run', color: 'blue', points: [{x: 0, y: 10}, {x: 1, y: 20}]}],
      onSelect: (x, options) => selected.push({x, options})});
    const root = host.children[0], hit = root.children.find(e => e.tag === 'rect');
    const marker = root.children.find(e => e.attrs.class === 'chart-selection');
    // The SVG is displayed at half its viewBox width: halfway across the plot is 0.5 km.
    hit.events.click({clientX: 100 + (52 + (600 - 52 - 14) / 2) / 2});
    assert.equal(selected[0].x, .5);
    assert.equal(marker.attrs.x1, '319');
    hit.events.pointerleave();
    assert.equal(marker.attrs.visibility, 'visible');
    chart.setSelection(.25);
    assert.equal(hit.attrs['aria-valuenow'], '0.25');
    assert.equal(selected.length, 1, 'synchronizing charts must not trigger another selection');
    let prevented = 0;
    for (const key of ['End', 'Home', 'ArrowRight', 'ArrowLeft']) hit.events.keydown({key, preventDefault() {prevented++;}});
    assert.deepEqual(selected.slice(1).map(s => s.x), [1, 0, .01, 0]);
    assert.equal(prevented, 4);
    assert.deepEqual(selected[1].options, {reveal: false});
    chart.setSelection(null);
    assert.equal(marker.attrs.visibility, 'hidden');
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});
