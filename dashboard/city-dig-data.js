'use strict';

/*
 * City Dig's bundled store guide. Coordinates and OpenStreetMap object references are derived
 * from OpenStreetMap data and distributed under ODbL 1.0: https://www.openstreetmap.org/copyright
 * Store-to-Discogs links are independently verified against the stores' public Discogs profiles.
 * A missing sellerUsername is deliberate: the physical shop is useful on the map, but City Dig
 * will not scan an unverified or guessed marketplace account.
 */
const CITY_DIG_CITIES = [
  {
    id: 'antwerp',
    name: 'Antwerp',
    country: 'Belgium',
    center: { lat: 51.2194, lon: 4.4052 },
    bounds: { north: 51.2325, south: 51.2115, east: 4.4245, west: 4.3900 },
    stores: [
      {
        id: 'chelsea-records',
        name: 'Chelsea Records',
        address: 'Kloosterstraat 10',
        lat: 51.2173092,
        lon: 4.3956897,
        osmUrl: 'https://www.openstreetmap.org/node/5419041508',
        sellerUsername: null,
      },
      {
        id: 'wallys-groove-world',
        name: "Wally's Groove World",
        address: 'Lange Nieuwstraat 126',
        lat: 51.2194147,
        lon: 4.4136227,
        osmUrl: 'https://www.openstreetmap.org/way/494810091',
        website: 'https://wgwstore.com/',
        sellerUsername: 'wgwstore',
        inventoryCount: 71510,
        specialties: ['Electronic', 'House', 'Techno', 'Disco'],
      },
      {
        id: 'tune-up',
        name: 'Tune Up',
        address: 'Melkmarkt 20',
        lat: 51.2203869,
        lon: 4.4025749,
        osmUrl: 'https://www.openstreetmap.org/node/11693621684',
        sellerUsername: 'Tune-Up-Records',
        inventoryCount: 3636,
        specialties: ['Jazz', 'Soul', 'Rock', 'Electronic'],
      },
      {
        id: 'inside-records',
        name: 'Inside Records',
        address: 'Sint-Jacobsmarkt 72',
        lat: 51.2200200,
        lon: 4.4136706,
        osmUrl: 'https://www.openstreetmap.org/node/3235183632',
        sellerUsername: null,
      },
      {
        id: 'rocking-bull',
        name: 'The Rocking Bull',
        address: 'Sint-Jacobsmarkt 77–79',
        lat: 51.2201083,
        lon: 4.4144199,
        osmUrl: 'https://www.openstreetmap.org/way/495911432',
        website: 'https://shop.therockingbull.rocks/',
        sellerUsername: null,
        specialties: ['Metal', 'Rock'],
      },
      {
        id: 'sugar-pie',
        name: 'Sugar Pie Records',
        address: 'Gierstraat 3',
        lat: 51.2184187,
        lon: 4.3995435,
        osmUrl: 'https://www.openstreetmap.org/way/497226708',
        sellerUsername: null,
        specialties: ['Jazz', 'Funk', 'Soul', 'Hip Hop'],
      },
      {
        id: 'bananarama',
        name: 'Bananarama Vinyl Records',
        address: 'Pelikaanstraat 3/1280',
        lat: 51.2146384,
        lon: 4.4207541,
        osmUrl: 'https://www.openstreetmap.org/node/13369861753',
        sellerUsername: null,
      },
      {
        id: 'backtrack',
        name: 'Backtrack',
        address: 'Sint-Katelijnevest',
        lat: 51.2197564,
        lon: 4.4051435,
        osmUrl: 'https://www.openstreetmap.org/node/5986863748',
        sellerUsername: null,
      },
      {
        id: 'record-collector',
        name: 'The Record Collector',
        address: 'Historic centre',
        lat: 51.2210247,
        lon: 4.4019027,
        osmUrl: 'https://www.openstreetmap.org/node/11693640424',
        sellerUsername: null,
      },
    ],
  },
];

if (typeof module !== 'undefined' && module.exports) module.exports = { CITY_DIG_CITIES };
if (typeof window !== 'undefined') window.CITY_DIG_CITIES = CITY_DIG_CITIES;

