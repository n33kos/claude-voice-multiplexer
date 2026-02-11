export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number;
  connections: number;
  targetHueOffset: number;
}

export interface Connection {
  i: number;
  j: number;
  distance: number;
}
