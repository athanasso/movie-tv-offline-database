/**
 * build_database.js
 *
 * Daily Automated Movie & TV Offline Database + Universal ID Map + Ratings Aggregator.
 * 
 * 1. Streams official IMDb rating datasets (title.ratings.tsv.gz).
 * 2. Fetches universal ID mappings from Wikidata (IMDb, TMDB, TVDB, Trakt, Letterboxd).
 * 3. Streams full IMDb catalog (title.basics.tsv.gz) — NO inclusion/vote threshold.
 * 4. Streams 4 distribution files to disk (zero memory limits, handles 1.2M+ titles):
 *    - movie-tv-offline-database-minified.json
 *    - movie-tv-offline-database.json
 *    - movie-tv-mapping.json
 *    - movie-tv-ratings.json
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');

const DIST_DIR = path.join(__dirname, 'dist');
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';

function getDailyTag(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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
  console.log('1/4 Streaming all IMDb ratings (title.ratings.tsv.gz)...');
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

    ratings.set(id, { rating, votes });
  }

  console.log(`Indexed all ${ratings.size.toLocaleString()} rated titles.`);
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

  // 2. Movies across partitioned date blocks
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

function writeJsonArrayStream(filePath, meta, items, pretty = false) {
  return new Promise((resolve, reject) => {
    const ws = fsSync.createWriteStream(filePath, { encoding: 'utf8' });
    ws.on('error', reject);

    const indent = pretty ? '  ' : '';
    const newline = pretty ? '\n' : '';

    ws.write(`{${newline}`);
    ws.write(`${indent}"license": ${JSON.stringify(meta.license)},${newline}`);
    ws.write(`${indent}"repository": ${JSON.stringify(meta.repository)},${newline}`);
    ws.write(`${indent}"lastUpdate": ${JSON.stringify(meta.lastUpdate)},${newline}`);
    ws.write(`${indent}"totalEntries": ${items.length},${newline}`);
    ws.write(`${indent}"data": [${newline}`);

    let i = 0;
    function writeNext() {
      let ok = true;
      while (i < items.length && ok) {
        const itemStr = pretty
          ? JSON.stringify(items[i], null, 2).replace(/\n/g, '\n' + indent + indent)
          : JSON.stringify(items[i]);
        const comma = (i < items.length - 1) ? ',' : '';
        const line = `${indent}${indent}${itemStr}${comma}${newline}`;
        i++;
        ok = ws.write(line);
      }
      if (i < items.length) {
        ws.once('drain', writeNext);
      } else {
        ws.write(`${indent}]${newline}}${newline}`);
        ws.end(resolve);
      }
    }

    writeNext();
  });
}

function writeMappingStream(filePath, mappingObj) {
  return new Promise((resolve, reject) => {
    const ws = fsSync.createWriteStream(filePath, { encoding: 'utf8' });
    ws.on('error', reject);

    ws.write('{\n  "by_imdb": {\n');
    const imdbKeys = Object.keys(mappingObj.by_imdb);
    for (let i = 0; i < imdbKeys.length; i++) {
      const k = imdbKeys[i];
      const val = JSON.stringify(mappingObj.by_imdb[k]);
      const comma = i < imdbKeys.length - 1 ? ',' : '';
      ws.write(`    ${JSON.stringify(k)}: ${val}${comma}\n`);
    }

    ws.write('  },\n  "by_tmdb_movie": {\n');
    const movieKeys = Object.keys(mappingObj.by_tmdb_movie);
    for (let i = 0; i < movieKeys.length; i++) {
      const k = movieKeys[i];
      const val = JSON.stringify(mappingObj.by_tmdb_movie[k]);
      const comma = i < movieKeys.length - 1 ? ',' : '';
      ws.write(`    ${JSON.stringify(k)}: ${val}${comma}\n`);
    }

    ws.write('  },\n  "by_tmdb_tv": {\n');
    const tvKeys = Object.keys(mappingObj.by_tmdb_tv);
    for (let i = 0; i < tvKeys.length; i++) {
      const k = tvKeys[i];
      const val = JSON.stringify(mappingObj.by_tmdb_tv[k]);
      const comma = i < tvKeys.length - 1 ? ',' : '';
      ws.write(`    ${JSON.stringify(k)}: ${val}${comma}\n`);
    }

    ws.write('  },\n  "by_tvdb": {\n');
    const tvdbKeys = Object.keys(mappingObj.by_tvdb);
    for (let i = 0; i < tvdbKeys.length; i++) {
      const k = tvdbKeys[i];
      const val = JSON.stringify(mappingObj.by_tvdb[k]);
      const comma = i < tvdbKeys.length - 1 ? ',' : '';
      ws.write(`    ${JSON.stringify(k)}: ${val}${comma}\n`);
    }

    ws.write('  }\n}\n');
    ws.end(resolve);
  });
}

function writeRatingsStream(filePath, ratingsMap) {
  return new Promise((resolve, reject) => {
    const ws = fsSync.createWriteStream(filePath, { encoding: 'utf8' });
    ws.on('error', reject);

    ws.write('{\n');
    let first = true;
    for (const [id, r] of ratingsMap.entries()) {
      if (!first) ws.write(',\n');
      first = false;
      ws.write(`  ${JSON.stringify(id)}: {"score":${r.rating},"votes":${r.votes}}`);
    }
    ws.write('\n}\n');
    ws.end(resolve);
  });
}

async function buildDatabase() {
  try {
    const tag = getDailyTag();
    console.log(`=== Building Movie & TV Offline Database [${tag}] ===`);

    await fs.mkdir(DIST_DIR, { recursive: true });

    // Step 1: IMDb Ratings
    const ratingsMap = await loadRatings();

    // Step 2: Wikidata Mappings
    const mappingsMap = await loadWikidataMappings();

    // Step 3: Stream IMDb Basics (NO vote threshold: includes all movies & TV series)
    console.log('3/4 Streaming full IMDb catalog (title.basics.tsv.gz)...');
    const basicsStream = await fetchGzipStream('https://datasets.imdbws.com/title.basics.tsv.gz');
    const rl = readline.createInterface({ input: basicsStream, crlfDelay: Infinity });

    const dataset = [];
    let processedLines = 0;

    const ALLOWED_TYPES = new Set(['movie', 'tvSeries', 'tvMiniSeries', 'tvMovie']);

    for await (const line of rl) {
      processedLines++;
      if (processedLines === 1) continue;

      const cols = line.split('\t');
      const titleType = cols[1];
      if (!ALLOWED_TYPES.has(titleType)) continue;

      const isAdult = cols[4] === '1';
      if (isAdult) continue; // Exclude adult content

      const tconst = cols[0];
      const isMovie = titleType === 'movie' || titleType === 'tvMovie';
      const primaryTitle = cleanTitle(cols[2]);
      const originalTitle = cleanTitle(cols[3]);
      const startYear = cols[5] !== '\\N' ? parseInt(cols[5], 10) : null;
      const runtime = cols[7] !== '\\N' ? parseInt(cols[7], 10) : null;
      const genres = cols[8] !== '\\N' ? cols[8].split(',').filter(Boolean) : [];

      const r = ratingsMap.get(tconst);
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
        ratings: r ? {
          imdb: {
            score: r.rating,
            votes: r.votes
          }
        } : undefined,
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

    // Sort by popularity (vote count descending; unrated titles sorted by year descending)
    dataset.sort((a, b) => {
      const va = a.ratings?.imdb?.votes || 0;
      const vb = b.ratings?.imdb?.votes || 0;
      if (vb !== va) return vb - va;
      return (b.year || 0) - (a.year || 0);
    });

    console.log(`Processed ${processedLines.toLocaleString()} catalog lines.`);
    console.log(`Catalog size: ${dataset.length.toLocaleString()} total movies & TV series.`);

    // Step 4: Stream distribution assets to disk
    console.log('4/4 Writing production distribution files via high-throughput stream...');

    const meta = {
      license: {
        type: 'CC BY-NC 4.0 & ODbL',
        text: 'Non-commercial data aggregated from IMDb, Wikidata, and TMDB.',
        sources: ['https://datasets.imdbws.com/', 'https://query.wikidata.org/', 'https://www.themoviedb.org/']
      },
      repository: 'https://github.com/athanasso/movie-tv-offline-database',
      lastUpdate: new Date().toISOString()
    };

    // 1. Minified full dataset
    const fullMinPath = path.join(DIST_DIR, 'movie-tv-offline-database-minified.json');
    console.log('Streaming movie-tv-offline-database-minified.json...');
    await writeJsonArrayStream(fullMinPath, meta, dataset, false);

    // 2. Formatted full dataset
    const fullPath = path.join(DIST_DIR, 'movie-tv-offline-database.json');
    console.log('Streaming movie-tv-offline-database.json...');
    await writeJsonArrayStream(fullPath, meta, dataset, true);

    // 3. Universal ID Cross-Reference Map
    console.log('Streaming movie-tv-mapping.json...');
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
    await writeMappingStream(path.join(DIST_DIR, 'movie-tv-mapping.json'), mappingObj);

    // 4. Compact Ratings Matrix
    console.log('Streaming movie-tv-ratings.json...');
    await writeRatingsStream(path.join(DIST_DIR, 'movie-tv-ratings.json'), ratingsMap);

    // Stats breakdown for release notes
    let movieCount = 0, tvCount = 0;
    let tmdbMapped = 0, tvdbMapped = 0, traktMapped = 0, letterboxdMapped = 0, ratedCount = 0;

    for (const item of dataset) {
      if (item.type === 'movie') movieCount++;
      else tvCount++;
      if (item.ratings?.imdb?.score) ratedCount++;
      if (item.mapping?.tmdb_id) tmdbMapped++;
      if (item.mapping?.tvdb_id) tvdbMapped++;
      if (item.mapping?.trakt_id) traktMapped++;
      if (item.mapping?.letterboxd) letterboxdMapped++;
    }

    const releaseNotes = [
      `## Release ${tag}`,
      '',
      'Automated daily build of **Movie & TV Offline Database + Universal ID Map + Ratings Aggregator**.',
      '',
      '### 📊 Dataset Statistics',
      `- **Total Titles (Complete Catalog)**: \`${dataset.length.toLocaleString()}\``,
      `- **Feature Films & Movies**: \`${movieCount.toLocaleString()}\``,
      `- **TV Shows & Mini-Series**: \`${tvCount.toLocaleString()}\``,
      `- **Rated Titles with Scores & Votes**: \`${ratedCount.toLocaleString()}\``,
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
      '| `movie-tv-ratings.json` | Complete ratings and vote counts matrix across all rated titles | Aggregator |',
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
