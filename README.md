# Movie & TV Offline Database + Universal ID Map + Ratings Aggregator

[![Automated Daily Build](https://github.com/athanasso/movie-tv-offline-database/actions/workflows/update-database.yml/badge.svg)](https://github.com/athanasso/movie-tv-offline-database/actions/workflows/update-database.yml)
[![Latest Release](https://img.shields.io/github/v/release/athanasso/movie-tv-offline-database?label=latest%20release&color=blue)](https://github.com/athanasso/movie-tv-offline-database/releases/latest)
[![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0%20%26%20ODbL-lightgrey.svg)](LICENSE)

An automated, open-source dataset unifying **Movies & TV Shows** across the entire media ecosystem:
1. **Complete Offline Database**: **1.29M+ movies & TV series** (entire IMDb movie & TV catalog with **no vote threshold**) with titles, year, runtime, genres, ratings, and cross-platform source links.
2. **Universal ID Cross-Reference Map**: Direct 1:1 bidirectional mapping across **IMDb**, **TheMovieDB (TMDB)**, **TheTVDB**, **Letterboxd**, **Trakt**, and **Wikidata**.
3. **Unified Ratings Aggregator**: Scores and vote counts from official IMDb datasets across all 1.7M+ rated titles.

Built for developers of self-hosted media servers (Jellyfin, Plex, Kodi), mobile tracker apps, recommendation engines, and data science.

---

## 📦 Distribution Assets

Every daily release provides 4 distinct distribution assets:

| Asset | Format | Purpose | Direct Download |
|---|---|---|---|
| `movie-tv-offline-database-minified.json` | JSON (Minified) | Production & client-side apps | [Download](https://github.com/athanasso/movie-tv-offline-database/releases/latest/download/movie-tv-offline-database-minified.json) |
| `movie-tv-offline-database.json` | JSON (Formatted) | Human inspection & development | [Download](https://github.com/athanasso/movie-tv-offline-database/releases/latest/download/movie-tv-offline-database.json) |
| `movie-tv-mapping.json` | JSON (Indexed) | Bidirectional ID cross-reference | [Download](https://github.com/athanasso/movie-tv-offline-database/releases/latest/download/movie-tv-mapping.json) |
| `movie-tv-ratings.json` | JSON (Key-Value) | Full scores & vote matrix | [Download](https://github.com/athanasso/movie-tv-offline-database/releases/latest/download/movie-tv-ratings.json) |

---

## 📊 Dataset Schema

### 1. Offline Database Entry (`movie-tv-offline-database.json`)

```json
{
  "id": "tt0111161",
  "title": "The Shawshank Redemption",
  "originalTitle": "The Shawshank Redemption",
  "type": "movie",
  "year": 1994,
  "runtime": 142,
  "genres": [
    "Drama"
  ],
  "ratings": {
    "imdb": {
      "score": 9.3,
      "votes": 2980450
    }
  },
  "mapping": {
    "tmdb_id": 278,
    "tvdb_id": 414,
    "trakt_id": "the-shawshank-redemption-1994",
    "letterboxd": "the-shawshank-redemption",
    "wikidata_id": "Q172241"
  },
  "sources": [
    "https://letterboxd.com/film/the-shawshank-redemption",
    "https://thetvdb.com/dereferrer/series/414",
    "https://trakt.tv/movies/the-shawshank-redemption-1994",
    "https://www.imdb.com/title/tt0111161",
    "https://www.themoviedb.org/movie/278",
    "https://www.wikidata.org/wiki/Q172241"
  ]
}
```

### 2. Universal ID Mapping Table (`movie-tv-mapping.json`)

Fast $O(1)$ bidirectional lookup across identifiers:

```json
{
  "by_imdb": {
    "tt0111161": {
      "type": "movie",
      "tmdb_id": 278,
      "tvdb_id": 414,
      "trakt_id": "the-shawshank-redemption-1994",
      "letterboxd": "the-shawshank-redemption",
      "wikidata_id": "Q172241"
    },
    "tt0944947": {
      "type": "tv",
      "tmdb_id": 1399,
      "tvdb_id": 121361,
      "trakt_id": "game-of-thrones",
      "wikidata_id": "Q23572"
    }
  },
  "by_tmdb_movie": {
    "278": "tt0111161"
  },
  "by_tmdb_tv": {
    "1399": "tt0944947"
  },
  "by_tvdb": {
    "121361": "tt0944947"
  }
}
```

### 3. Ratings Matrix (`movie-tv-ratings.json`)

```json
{
  "tt0111161": {
    "score": 9.3,
    "votes": 2980450
  },
  "tt0068646": {
    "score": 9.2,
    "votes": 2040120
  }
}
```

---

## 🚀 Quick Start & Usage

### JavaScript / TypeScript (Node.js)

```javascript
// Fetch latest mapping in real-time
const res = await fetch('https://github.com/athanasso/movie-tv-offline-database/releases/latest/download/movie-tv-mapping.json');
const mapping = await res.json();

// Look up TMDB movie ID from IMDb
const imdbId = 'tt0111161';
const tmdbId = mapping.by_imdb[imdbId]?.tmdb_id;
console.log(`IMDb ${imdbId} -> TMDB ${tmdbId}`);

// Reverse lookup: TMDB show to IMDb
const showImdb = mapping.by_tmdb_tv['1399'];
console.log(`TMDB TV 1399 -> IMDb ${showImdb}`);
```

### Python

```python
import urllib.request
import json

url = "https://github.com/athanasso/movie-tv-offline-database/releases/latest/download/movie-tv-mapping.json"
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as response:
    mapping = json.loads(response.read().decode())

# Resolve IMDb ID from TMDB
tmdb_id = "278"
imdb_id = mapping["by_tmdb_movie"].get(tmdb_id)
print(f"TMDB {tmdb_id} is IMDb {imdb_id}")
```

---

## ⚙️ Automated Updates

The dataset is rebuilt and published automatically **every day at 04:00 UTC** via GitHub Actions. Releases are tagged by calendar date (e.g., `2026-09-12`).

---

## 📜 Attribution & License

- Non-commercial distribution.
- Metadata and ratings derived from official public datasets provided by [IMDb](https://datasets.imdbws.com/), [Wikidata](https://www.wikidata.org/) (ODbL), and [The Movie Database (TMDB)](https://www.themoviedb.org/).
- This product uses the TMDB and IMDb data but is not endorsed or certified by TMDB or IMDb.
