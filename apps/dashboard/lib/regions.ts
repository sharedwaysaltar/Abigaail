// Hosting region codes the map knows, with the city each one is in. A code
// that is not here is listed under "Not on the map"; add a line to place it.
// Codes are what ABIGAAIL_REGION carries (uppercased by the SDK).

import type { RegionInfo } from "@abigaail/insights";

const r = (lat: number, lon: number, city: string): RegionInfo => ({ lat, lon, city });

export const REGIONS: Readonly<Record<string, RegionInfo>> = {
  // DigitalOcean
  NYC1: r(40.71, -74.01, "New York"),
  NYC2: r(40.71, -74.01, "New York"),
  NYC3: r(40.71, -74.01, "New York"),
  SFO1: r(37.77, -122.42, "San Francisco"),
  SFO2: r(37.77, -122.42, "San Francisco"),
  SFO3: r(37.77, -122.42, "San Francisco"),
  TOR1: r(43.65, -79.38, "Toronto"),
  ATL1: r(33.75, -84.39, "Atlanta"),
  AMS2: r(52.37, 4.9, "Amsterdam"),
  AMS3: r(52.37, 4.9, "Amsterdam"),
  LON1: r(51.51, -0.13, "London"),
  FRA1: r(50.11, 8.68, "Frankfurt"),
  BLR1: r(12.97, 77.59, "Bangalore"),
  SGP1: r(1.35, 103.82, "Singapore"),
  SYD1: r(-33.87, 151.21, "Sydney"),
  // Hetzner
  FSN1: r(50.48, 12.37, "Falkenstein"),
  NBG1: r(49.45, 11.08, "Nuremberg"),
  HEL1: r(60.17, 24.94, "Helsinki"),
  ASH: r(39.04, -77.49, "Ashburn"),
  HIL: r(45.52, -122.99, "Hillsboro"),
  SIN: r(1.35, 103.82, "Singapore"),
  // AWS
  "US-EAST-1": r(39.04, -77.49, "N. Virginia"),
  "US-EAST-2": r(40.0, -83.0, "Ohio"),
  "US-WEST-1": r(37.35, -121.96, "N. California"),
  "US-WEST-2": r(45.84, -119.7, "Oregon"),
  "CA-CENTRAL-1": r(45.5, -73.57, "Montreal"),
  "SA-EAST-1": r(-23.55, -46.63, "São Paulo"),
  "EU-WEST-1": r(53.35, -6.26, "Dublin"),
  "EU-WEST-2": r(51.51, -0.13, "London"),
  "EU-WEST-3": r(48.86, 2.35, "Paris"),
  "EU-CENTRAL-1": r(50.11, 8.68, "Frankfurt"),
  "EU-NORTH-1": r(59.33, 18.07, "Stockholm"),
  "AP-SOUTH-1": r(19.08, 72.88, "Mumbai"),
  "AP-SOUTHEAST-1": r(1.35, 103.82, "Singapore"),
  "AP-SOUTHEAST-2": r(-33.87, 151.21, "Sydney"),
  "AP-NORTHEAST-1": r(35.68, 139.69, "Tokyo"),
  // Fly.io
  LHR: r(51.51, -0.13, "London"),
  AMS: r(52.37, 4.9, "Amsterdam"),
  FRA: r(50.11, 8.68, "Frankfurt"),
  CDG: r(48.86, 2.35, "Paris"),
  IAD: r(38.95, -77.45, "Ashburn"),
  ORD: r(41.88, -87.63, "Chicago"),
  SJC: r(37.34, -121.89, "San Jose"),
  NRT: r(35.68, 139.69, "Tokyo"),
  SYD: r(-33.87, 151.21, "Sydney"),
};

export const regionInfo = (code: string): RegionInfo | undefined => REGIONS[code];
