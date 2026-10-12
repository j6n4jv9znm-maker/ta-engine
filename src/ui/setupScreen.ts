import { latin1 } from '../formats/hpi';
import { parseOta, type OtaInfo } from '../formats/ota';
import type { Palette } from '../formats/palette';
import { parseTdf } from '../formats/tdf';
import { parseTnt, type TntMap } from '../formats/tnt';
import type { SkirmishSettings } from '../sim/skirmish';
import { loadMission, type Campaign } from '../map/mission';
import type { Vfs } from '../vfs';

/*
 * The game setup screen: pick a map (with a preview of its minimap and start positions), your side,
 * the opponent and how to start, then Start. Plain DOM; it only reads map files.
 */

export type GameSettings = SkirmishSettings;

interface MapInfo {
  tnt: TntMap;
  ota: OtaInfo | undefined;
  starts: { x: number; z: number }[];
  water: number;
}

const STORE_KEY = 'ta.setup';

export class SetupScreen {
  readonly el: HTMLElement;
  settings: GameSettings;
  private readonly info = new Map<string, Promise<MapInfo | undefined>>();
  private readonly list: HTMLElement;
  private readonly preview: HTMLCanvasElement;
  private readonly details: HTMLElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly extra: HTMLElement;
  private shown = 0;

  constructor(
    private readonly vfs: Vfs,
    private readonly palette: Palette,
    private readonly maps: string[],
    private readonly onStart: (s: GameSettings) => void,
    private readonly onResume: () => void,
    private readonly campaigns: Campaign[] = [],
  ) {
    const saved = load();
    const preferred = ['Ashap Plateau', 'The Pass'].find((n) => maps.includes(n)) ?? maps[0] ?? '';
    this.settings = {
      map: saved?.map && maps.includes(saved.map) ? saved.map : preferred,
      side: saved?.side ?? 'arm',
      opponent: saved?.opponent ?? 'medium',
      startWith: saved?.startWith ?? 'commander',
    };

    this.el = document.createElement('div');
    this.el.id = 'setup';
    this.el.innerHTML = `
      <div class="setup-box">
        <h1>Total Annihilation</h1>
        <div class="setup-cols">
          <div class="setup-maps"><div class="choice setup-mode"><button data-mode="skirmish">Skirmish</button><button data-mode="campaign">Campaign</button></div><div class="setup-list"></div></div>
          <div class="setup-preview"><canvas></canvas><div class="setup-details"></div></div>
          <div class="setup-options">
            <h2>You play</h2>
            <div class="choice" data-key="side"><button data-v="arm">Arm</button><button data-v="core">Core</button></div>
            <h2>Against</h2>
            <div class="choice" data-key="opponent"><button data-v="easy">Easy</button><button data-v="medium">Medium</button><button data-v="hard">Hard</button></div>
            <div class="setup-extra">
              <h2>Start with</h2>
              <div class="choice" data-key="startWith"><button data-v="commander">Commander</button><button data-v="army">Two armies</button></div>
              <div class="choice" data-key="opponent"><button data-v="none">Nobody (sandbox)</button></div>
            </div>
            <div class="setup-actions">
              <button class="big start">Start game</button>
              <button class="big resume">Back to the game</button>
              <div class="setup-slot"></div>
            </div>
          </div>
        </div>
      </div>`;
    this.list = this.el.querySelector('.setup-list')!;
    this.preview = this.el.querySelector('.setup-preview canvas')!;
    this.details = this.el.querySelector('.setup-details')!;
    this.resumeBtn = this.el.querySelector('.resume')!;
    this.extra = this.el.querySelector('.setup-extra')!;

    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.setup-mode button')) {
      b.addEventListener('click', () => this.showList(b.dataset.mode === 'campaign'));
    }
    this.showList(!!this.settings.mission);
    for (const group of this.el.querySelectorAll<HTMLElement>('.choice')) {
      const key = group.dataset.key as keyof GameSettings;
      for (const b of group.querySelectorAll<HTMLButtonElement>('button')) {
        b.addEventListener('click', () => {
          (this.settings as unknown as Record<string, string>)[key] = b.dataset.v!;
          this.refresh();
        });
      }
    }
    this.el.querySelector('.start')!.addEventListener('click', () => {
      save(this.settings);
      this.hide();
      this.onStart({ ...this.settings });
    });
    this.resumeBtn.addEventListener('click', () => {
      this.hide();
      this.onResume();
    });
    this.extra.hidden = false;
    this.refresh();
    if (this.settings.mission) this.pickMission(this.settings.mission);
    else this.pickMap(this.settings.map);
  }

  /** Fills the left list with skirmish maps, or with the campaigns' missions in order. */
  private showList(campaign: boolean): void {
    this.list.textContent = '';
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.setup-mode button')) b.classList.toggle('on', (b.dataset.mode === 'campaign') === campaign);
    if (!campaign) {
      for (const name of this.maps) {
        const b = document.createElement('button');
        b.textContent = name;
        b.dataset.map = name;
        b.addEventListener('click', () => this.pickMap(name));
        this.list.append(b);
      }
      if (this.settings.mission) this.pickMap(this.maps.includes(this.settings.map) ? this.settings.map : (this.maps[0] ?? ''));
      return;
    }
    for (const c of this.campaigns) {
      const h = document.createElement('h2');
      h.textContent = c.name;
      this.list.append(h);
      for (const m of c.missions) {
        const b = document.createElement('button');
        b.textContent = m.name;
        b.dataset.map = m.map;
        b.addEventListener('click', () => this.pickMission(m.map));
        this.list.append(b);
      }
    }
    if (!this.settings.mission && this.campaigns[0]?.missions[0]) this.pickMission(this.campaigns[0].missions[0].map);
  }

  /** A campaign mission: you play its side; the preview shows its map and the briefing. */
  private pickMission(map: string): void {
    const c = this.campaigns.find((x) => x.missions.some((m) => m.map === map));
    if (!c) return;
    this.settings.mission = map;
    this.settings.map = map;
    this.settings.side = c.side;
    this.refresh();
    const ticket = ++this.shown;
    this.details.textContent = 'Loading…';
    void Promise.all([this.mapInfo(map), loadMission(this.vfs, map).catch(() => undefined)]).then(([info, mission]) => {
      if (ticket !== this.shown) return;
      this.drawPreview(info, false);
      const name = c.missions.find((m) => m.map === map)?.name ?? map;
      this.details.innerHTML = [`<b>${escape(name)}</b>`, escape((mission?.briefing ?? '').replace(/&[A-Za-z]?/g, '')).replace(/\n/g, '<br>')].filter(Boolean).join('<br><br>');
    });
  }

  /** A spot under the Start button for extra actions (saved games). */
  get slot(): HTMLElement {
    return this.el.querySelector('.setup-slot')!;
  }

  show(canResume: boolean): void {
    this.resumeBtn.hidden = !canResume;
    this.el.hidden = false;
    this.list.querySelector<HTMLElement>(`[data-map="${CSS.escape(this.settings.map)}"]`)?.scrollIntoView({ block: 'center' });
  }

  hide(): void {
    this.el.hidden = true;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  private refresh(): void {
    for (const group of this.el.querySelectorAll<HTMLElement>('.choice')) {
      const key = group.dataset.key as keyof GameSettings;
      for (const b of group.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', this.settings[key] === b.dataset.v);
    }
    for (const b of this.list.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.map === this.settings.map);
  }

  private pickMap(name: string): void {
    this.settings.map = name;
    this.settings.mission = undefined;
    this.refresh();
    const ticket = ++this.shown;
    this.details.textContent = 'Loading…';
    void this.mapInfo(name).then((info) => {
      if (ticket !== this.shown) return;
      this.drawPreview(info);
      if (!info) {
        this.details.textContent = 'Could not read this map.';
        return;
      }
      const o = info.ota;
      const lines = [
        `<b>${escape(o?.missionName || name)}</b>`,
        o?.description ? escape(o.description) : '',
        `${info.starts.length} start positions${o?.size ? ` · ${escape(o.size)}` : ''}`,
        o ? `Wind ${o.minWindSpeed / 100}–${o.maxWindSpeed / 100} · tidal ${o.tidalStrength}` : '',
        info.water > 0.35 ? 'Lots of water: build a shipyard on the shore for ships.' : '',
        info.starts.length < 2 ? '<span class="warn">Only one start position: no room for an opponent.</span>' : '',
      ];
      this.details.innerHTML = lines.filter(Boolean).join('<br>');
    });
  }

  private mapInfo(name: string): Promise<MapInfo | undefined> {
    let p = this.info.get(name);
    if (!p) {
      p = (async () => {
        try {
          const tnt = parseTnt(await this.vfs.read(`maps/${name}.tnt`));
          const otaPath = `maps/${name}.ota`;
          const ota = this.vfs.exists(otaPath) ? parseOta(parseTdf(latin1(await this.vfs.read(otaPath)))) : undefined;
          const starts = (ota?.schemas[0]?.startPositions ?? []).filter((s): s is { x: number; z: number } => !!s);
          let wet = 0;
          for (const h of tnt.heights) if (h < tnt.seaLevel) wet++;
          return { tnt, ota, starts, water: wet / Math.max(1, tnt.heights.length) };
        } catch {
          return undefined;
        }
      })();
      this.info.set(name, p);
    }
    return p;
  }

  private drawPreview(info: MapInfo | undefined, starts = true): void {
    const c = this.preview;
    const g = c.getContext('2d')!;
    if (!info) {
      g.clearRect(0, 0, c.width, c.height);
      return;
    }
    const { width, height, pixels } = info.tnt.minimap;
    c.width = width;
    c.height = height;
    const img = new ImageData(width, height);
    for (let i = 0; i < pixels.length; i++) {
      const col = this.palette.color(pixels[i]!);
      img.data.set([col.r, col.g, col.b, 255], i * 4);
    }
    g.putImageData(img, 0, 0);
    const sx = width / (info.tnt.width * 16);
    const sz = height / (info.tnt.height * 16);
    g.font = 'bold 11px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // You start at position 1 and the computer at 2; the others are only shown faintly.
    if (!starts) return; // missions place their own units
    [...info.starts.entries()].reverse().forEach(([i, s]) => {
      const x = s.x * sx;
      const y = s.z * sz;
      g.fillStyle = i === 0 ? '#3b6cff' : i === 1 ? '#e33' : 'rgba(255,255,255,0.35)';
      g.beginPath();
      g.arc(x, y, i < 2 ? 8 : 3, 0, Math.PI * 2);
      g.fill();
      if (i < 2) {
        g.fillStyle = '#fff';
        g.fillText(i === 0 ? 'You' : 'AI', x, y - 14);
      }
    });
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

function load(): Partial<GameSettings> | undefined {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') ?? undefined;
  } catch {
    return undefined;
  }
}

function save(s: GameSettings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // private browsing: settings just aren't remembered
  }
}
