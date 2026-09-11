/**
 * build_database.js
 *
 * Automated Movie & TV Offline Database + Universal ID Map + Ratings Aggregator.
 * 
 * 1. Streams official IMDb rating datasets (title.ratings.tsv.gz) for unthrottled ratings & vote counts.
 * 2. Fetches universal ID mappings from Wikidata (IMDb, TMDB, TVDB, Trakt, Letterboxd).
 * 3. Streams official IMDb title basics (title.basics.tsv.gz) for curated movie & TV metadata.
 * 4. Generates 4 production assets:
 *    - movie-tv-offline-database-minified.json
 *    - movie-tv-offline-database.json
 *    - movie-tv-mapping.json
 *    - movie-tv-ratings.json
 */

const fs = require('fs/promises');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');

const DIST_DIR = path.join(__dirname, 'dist');
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';

// Minimum votes threshold for inclusion (filters out 95% unvoted student films & placeholders)
const MIN_VOTES_MOVIE = 100;
const MIN_VOTES_TV = 50;

function getWeekTag(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

function fetchGzipStream(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchGzipStream(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
      }
      const gunzip = zlib.createGunzip();
      res.pipe(gunzip);
      resolve(gunzip);
    }).on('error', reject);
  });
}

async function queryWikidata(sparqlQuery, retries = 3) {
  const url = `${WIKIDATA_ENDPOINT}?format=json&query=${encodeURIComponent(sparqlQuery)}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'MovieTvOfflineDatabase/1.0 (https://github.com/athanasso/movie-tv-offline-database)'
        }
      });
      if (res.ok) {
        const data = await res.json();
        return data.results?.bindings || [];
      }
      console.warn(`Wikidata query returned HTTP ${res.status} on attempt ${attempt}`);
    } catch (err) {
      console.warn(`Wikidata query failed on attempt ${attempt}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return [];
}

async function loadRatings() {
  console.log('1/4 Streaming IMDb ratings (title.ratings.tsv.gz)...');
  const stream = await fetchGzipStream('https://datasets.imdbws.com/title.ratings.tsv.gz');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const ratings = new Map();
  let lineCount = 0;

  for await (const line of rl) {
    lineCount++;
    if (lineCount === 1) continue; // skip TSV header
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;

    const id = line.substring(0, tab1);
    const rating = parseFloat(line.substring(tab1 + 1, tab2));
    const votes = parseInt(line.substring(tab2 + 1), 10);

    if (votes >= MIN_VOTES_TV) {
      ratings.set(id, { rating, votes });
    }
  }

  console.log(`Indexed ${ratings.size.toLocaleString()} titles with >= ${MIN_VOTES_TV} votes.`);
  return ratings;
}

async function loadWikidataMappings() {
  console.log('2/4 Fetching universal ID mappings from Wikidata (IMDb, TMDB, TVDB, Trakt, Letterboxd)...');
  const mappings = new Map();

  // 1. TV Series
  console.log('  -> Querying TV series...');
  const tvQuery = `
    SELECT ?imdb ?tmdb ?tvdb ?trakt ?item WHERE {
      ?item wdt:P345 ?imdb;
            wdt:P4983 ?tmdb .
      OPTIONAL { ?item wdt:P4835 ?tvdb }
      OPTIONAL { ?item wdt:P8014 ?trakt }
    }
  `;
  const tvResults = await queryWikidata(tvQuery);
  for (const row of tvResults) {
    const imdb = row.imdb?.value;
    if (!imdb) continue;
    const qid = row.item?.value?.split('/')?.pop();
    mappings.set(imdb, {
      type: 'tv',
      tmdb_id: row.tmdb?.value ? parseInt(row.tmdb.value, 10) : undefined,
      tvdb_id: row.tvdb?.value ? parseInt(row.tvdb.value, 10) : undefined,
      trakt_id: row.trakt?.value || undefined,
      wikidata_id: qid
    });
  }
  console.log(`  -> TV mappings loaded: ${tvResults.length.toLocaleString()}`);

  // 2. Movies across date partitions for zero-timeout execution
  const movieRanges = [
    'FILTER(?year >= 2020)',
    'FILTER(?year >= 2010 && ?year < 2020)',
    'FILTER(?year >= 2000 && ?year < 2010)',
    'FILTER(?year >= 1980 && ?year < 2000)',
    'FILTER(?year < 1980)'
  ];

  for (let i = 0; i < movieRanges.length; i++) {
    const range = movieRanges[i];
    console.log(`  -> Querying movie batch ${i + 1}/${movieRanges.length} (${range})...`);
    const movieQuery = `
      SELECT ?imdb ?tmdb ?tvdb ?letterboxd ?trakt ?item WHERE {
        ?item wdt:P345 ?imdb;
              wdt:P4947 ?tmdb;
              wdt:P577 ?d .
        BIND(YEAR(?d) AS ?year)
        ${range}
        OPTIONAL { ?item wdt:P4835 ?tvdb }
        OPTIONAL { ?item wdt:P6127 ?letterboxd }
        OPTIONAL { ?item wdt:P8013 ?trakt }
      }
    `;
    const results = await queryWikidata(movieQuery);
    for (const row of results) {
      const imdb = row.imdb?.value;
      if (!imdb) continue;
      const qid = row.item?.value?.split('/')?.pop();
      mappings.set(imdb, {
        type: 'movie',
        tmdb_id: row.tmdb?.value ? parseInt(row.tmdb.value, 10) : undefined,
        tvdb_id: row.tvdb?.value ? parseInt(row.tvdb.value, 10) : undefined,
        trakt_id: row.trakt?.value || undefined,
        letterboxd: row.letterboxd?.value || undefined,
        wikidata_id: qid
      });
    }
  }

  console.log(`Total cross-referenced media entries: ${mappings.size.toLocaleString()}`);
  return mappings;
}

function cleanTitle(str) {
  if (!str || str === '\\N') return null;
  return str.trim();
}

function formatSources(item, mapping) {
  const sources = [`https://www.imdb.com/title/${item.id}`];

  if (mapping) {
    if (mapping.tmdb_id) {
      const seg = mapping.type === 'tv' ? 'tv' : 'movie';
      sources.push(`https://www.themoviedb.org/${seg}/${mapping.tmdb_id}`);
    }
    if (mapping.tvdb_id) {
      sources.push(`https://thetvdb.com/dereferrer/series/${mapping.tvdb_id}`);
    }
    if (mapping.letterboxd) {
      sources.push(`https://letterboxd.com/film/${mapping.letterboxd}`);
    }
    if (mapping.trakt_id) {
      const seg = mapping.type === 'tv' ? 'shows' : 'movies';
      sources.push(`https://trakt.tv/${seg}/${mapping.trakt_id}`);
    }
    if (mapping.wikidata_id) {
      sources.push(`https://www.wikidata.org/wiki/${mapping.wikidata_id}`);
    }
  }

  return sources.sort();
}

async function buildDatabase() {
  try {
    const tag = getWeekTag();
    console.log(`=== Building Movie & TV Offline Database [${tag}] ===`);

    await fs.mkdir(DIST_DIR, { recursive: true });

    // Step 1: IMDb Ratings
    const ratingsMap = await loadRatings();

    // Step 2: Wikidata Mappings
    const mappingsMap = await loadWikidataMappings();

    // Step 3: Stream IMDb Basics & filter/combine
    console.log('3/4 Streaming IMDb basics (title.basics.tsv.gz)...');
    const basicsStream = await fetchGzipStream('https://datasets.imdbws.com/title.basics.tsv.gz');
    const rl = readline.createInterface({ input: basicsStream, crlfDelay: Infinity });

    const dataset = [];
    let processedLines = 0;

    const ALLOWED_TYPES = new Set(['movie', 'tvSeries', 'tvMiniSeries', 'tvMovie']);

    for await (const line of rl) {
      processedLines++;
      if (processedLines === 1) continue;

      const cols = line.split('\t');
      const tconst = cols[0];

      const r = ratingsMap.get(tconst);
      if (!r) continue;

      const titleType = cols[1];
      if (!ALLOWED_TYPES.has(titleType)) continue;

      const isMovie = titleType === 'movie' || titleType === 'tvMovie';
      const minVotes = isMovie ? MIN_VOTES_MOVIE : MIN_VOTES_TV;
      if (r.votes < minVotes) continue;

      const primaryTitle = cleanTitle(cols[2]);
      const originalTitle = cleanTitle(cols[3]);
      const isAdult = cols[4] === '1';
      if (isAdult) continue; // Exclude adult content

      const startYear = cols[5] !== '\\N' ? parseInt(cols[5], 10) : null;
      const runtime = cols[7] !== '\\N' ? parseInt(cols[7], 10) : null;
      const genres = cols[8] !== '\\N' ? cols[8].split(',').filter(Boolean) : [];

      const mapping = mappingsMap.get(tconst);
      const mediaType = isMovie ? 'movie' : 'tv_series';

      dataset.push({
        id: tconst,
        title: primaryTitle,
        originalTitle: originalTitle !== primaryTitle ? originalTitle : undefined,
        type: mediaType,
        year: startYear,
        runtime: runtime || undefined,
        genres,
        ratings: {
          imdb: {
            score: r.rating,
            votes: r.votes
          }
        },
        mapping: mapping ? {
          tmdb_id: mapping.tmdb_id,
          tvdb_id: mapping.tvdb_id,
          trakt_id: mapping.trakt_id,
          letterboxd: mapping.letterboxd,
          wikidata_id: mapping.wikidata_id
        } : undefined,
        sources: formatSources({ id: tconst }, mapping)
      });
    }

    // Sort by popularity (vote count descending)
    dataset.sort((a, b) => (b.ratings.imdb?.votes || 0) - (a.ratings.imdb?.votes || 0));
    console.log(`Processed ${processedLines.toLocaleString()} titles. Selected ${dataset.length.toLocaleString()} curated entries.`);

    // Step 4: Build assets
    console.log('4/4 Writing production distribution files...');

    // 1. Full database minified & formatted
    const fullMinPath = path.join(DIST_DIR, 'movie-tv-offline-database-minified.json');
    const fullPath = path.join(DIST_DIR, 'movie-tv-offline-database.json');

    const resultObj = {
      license: {
        type: 'CC BY-NC 4.0 & ODbL',
        text: 'Non-commercial data aggregated from IMDb, Wikidata, and TMDB.',
        sources: ['https://datasets.imdbws.com/', 'https://query.wikidata.org/', 'https://www.themoviedb.org/']
      },
      repository: 'https://github.com/athanasso/movie-tv-offline-database',
      lastUpdate: new Date().toISOString(),
      totalEntries: dataset.length,
      data: dataset
    };

    console.log('Writing movie-tv-offline-database-minified.json...');
    await fs.writeFile(fullMinPath, JSON.stringify(resultObj), 'utf8');

    console.log('Writing movie-tv-offline-database.json...');
    await fs.writeFile(fullPath, JSON.stringify(resultObj, null, 2), 'utf8');

    // 2. Universal ID Cross-Reference Map
    console.log('Writing movie-tv-mapping.json...');
    const mappingObj = {
      by_imdb: {},
      by_tmdb_movie: {},
      by_tmdb_tv: {},
      by_tvdb: {}
    };

    for (const item of dataset) {
      if (!item.mapping) continue;
      const m = item.mapping;
      mappingObj.by_imdb[item.id] = {
        type: item.type,
        tmdb_id: m.tmdb_id,
        tvdb_id: m.tvdb_id,
        trakt_id: m.trakt_id,
        letterboxd: m.letterboxd,
        wikidata_id: m.wikidata_id
      };
      if (m.tmdb_id) {
        if (item.type === 'movie') {
          mappingObj.by_tmdb_movie[m.tmdb_id] = item.id;
        } else {
          mappingObj.by_tmdb_tv[m.tmdb_id] = item.id;
        }
      }
      if (m.tvdb_id) {
        mappingObj.by_tvdb[m.tvdb_id] = item.id;
      }
    }
    await fs.writeFile(path.join(DIST_DIR, 'movie-tv-mapping.json'), JSON.stringify(mappingObj), 'utf8');

    // 3. Compact Ratings Matrix
    console.log('Writing movie-tv-ratings.json...');
    const ratingsObj = {};
    for (const item of dataset) {
      ratingsObj[item.id] = {
        score: item.ratings.imdb.score,
        votes: item.ratings.imdb.votes
      };
    }
    await fs.writeFile(path.join(DIST_DIR, 'movie-tv-ratings.json'), JSON.stringify(ratingsObj), 'utf8');

    // Stats breakdown for release notes
    let movieCount = 0, tvCount = 0;
    let tmdbMapped = 0, tvdbMapped = 0, traktMapped = 0, letterboxdMapped = 0;

    for (const item of dataset) {
      if (item.type === 'movie') movieCount++;
      else tvCount++;
      if (item.mapping?.tmdb_id) tmdbMapped++;
      if (item.mapping?.tvdb_id) tvdbMapped++;
      if (item.mapping?.trakt_id) traktMapped++;
      if (item.mapping?.letterboxd) letterboxdMapped++;
    }

    const releaseNotes = [
      `## Release ${tag}`,
      '',
      'Automated weekly build of **Movie & TV Offline Database + Universal ID Map + Ratings Aggregator**.',
      '',
      '### 📊 Dataset Statistics',
      `- **Total Curated Titles**: \`${dataset.length.toLocaleString()}\``,
      `- **Feature Films & Movies**: \`${movieCount.toLocaleString()}\``,
      `- **TV Shows & Mini-Series**: \`${tvCount.toLocaleString()}\``,
      `- **IMDb Links & Ratings**: \`${dataset.length.toLocaleString()}\``,
      `- **TMDB Mapped IDs**: \`${tmdbMapped.toLocaleString()}\``,
      `- **TheTVDB Mapped IDs**: \`${tvdbMapped.toLocaleString()}\``,
      `- **Letterboxd Mapped Slugs**: \`${letterboxdMapped.toLocaleString()}\``,
      `- **Trakt Mapped IDs**: \`${traktMapped.toLocaleString()}\``,
      '',
      '### 📦 Distribution Assets',
      '| Asset | Description | Size |',
      '|---|---|---|',
      '| `movie-tv-offline-database-minified.json` | Complete offline database (minified) | Production |',
      '| `movie-tv-offline-database.json` | Pretty-printed full database | Development |',
      '| `movie-tv-mapping.json` | Bidirectional cross-reference ID lookup (`IMDb` ↔ `TMDB` ↔ `TheTVDB` ↔ `Letterboxd` ↔ `Trakt`) | Lightweight |',
      '| `movie-tv-ratings.json` | Standalone ratings and vote counts matrix | Aggregator |',
      ''
    ].join('\n');

    await fs.writeFile(path.join(DIST_DIR, 'release_notes.md'), releaseNotes, 'utf8');
    await fs.writeFile(path.join(DIST_DIR, 'tag.txt'), tag, 'utf8');

    console.log(`=== Done! Release ${tag} generated successfully with ${dataset.length.toLocaleString()} titles. ===`);
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

buildDatabase();
