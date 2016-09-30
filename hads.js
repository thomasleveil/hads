'use strict';

const Promise = require('bluebird');
const fs = Promise.promisifyAll(require('fs'));
const mkdirpAsync = Promise.promisify(require('mkdirp'));
const os = require('os');
const path = require('path');
const optimist = require('optimist');
const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const pkg = require('./package.json');
const Matcher = require('./lib/matcher.js');
const Renderer = require('./lib/renderer.js');
const Helpers = require('./lib/helpers.js');
const Indexer = require('./lib/indexer.js');

let args = optimist
  .usage(`\n${pkg.name} ${pkg.version}\nUsage: $0 [root dir] [options]`)
  .alias('p', 'port')
  .describe('p', 'Port number to listen on')
  .default('p', 4040)
  .alias('h', 'host')
  .describe('h', 'Host address to bind to')
  .default('h', 'localhost')
  .alias('o', 'open')
  .boolean('o')
  .describe('o', 'Open default browser on start')
  .describe('help', 'Show this help')
  .argv;

if (args.help || args._.length > 1) {
  optimist.showHelp(console.log);
  process.exit();
}

let docPath = args._[0] || './';
let rootPath = path.resolve(docPath);
let indexer = new Indexer(rootPath);
let renderer = new Renderer(indexer);
let app = express();

app.set('views', path.join(__dirname, '/views'));
app.set('view engine', 'pug');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.use('/_hads/', express.static(path.join(__dirname, '/public')));
app.use('/_hads/highlight/', express.static(path.join(__dirname, 'node_modules/highlight.js/styles')));
app.use('/_hads/octicons/', express.static(path.join(__dirname, 'node_modules/octicons/build/font')));
app.use('/_hads/ace/', express.static(path.join(__dirname, 'node_modules/ace-builds/src-min/')));
app.use('/_hads/mermaid/', express.static(path.join(__dirname, 'node_modules/mermaid/dist/')));
app.use('/_hads/dropzone/', express.static(path.join(__dirname, 'node_modules/dropzone/dist/min/')));

const ROOT_FILES = ['index.md', 'README.md', 'readme.md'];
const STYLESHEETS = ['/highlight/github.css', '/octicons/octicons.css', '/css/github.css', '/css/style.css',
  '/mermaid/mermaid.forest.css'];
const SCRIPTS = ['/ace/ace.js', '/mermaid/mermaid.min.js', '/dropzone/dropzone.min.js', '/js/client.js'];

app.post('/_hads/upload', [multer({
  dest: path.join(rootPath, 'images'),  // os.tmpdir()
  limits: {
    fileSize: 1024 * 10   // 10 MB
  }
}).single('file'), (req, res) => {
  console.log(req.file);
  res.json(path.relative(rootPath, req.file.path));
}]);

app.get('*', (req, res, next) => {
  let route = Helpers.extractRoute(req.path);
  let query = req.query || {};
  let rootIndex = -1;
  let create = Helpers.hasQueryOption(query, 'create');
  let edit = Helpers.hasQueryOption(query, 'edit') || create;
  let filePath, icon, search, error, title, contentPromise;

  function renderPage() {
    if (error) {
      edit = false;
      contentPromise = Promise.resolve(renderer.renderMarkdown(error));
      icon = 'octicon-alert';
    } else if (search) {
      contentPromise = renderer.renderSearch(query.search);
      icon = 'octicon-search';
    } else if (Helpers.hasQueryOption(query, 'raw')) {
      // Access raw content: images, code, etc
      return res.sendFile(filePath);
    } else if (Matcher.isMarkdown(filePath)) {
      contentPromise = edit ? renderer.renderRaw(filePath) : renderer.renderFile(filePath);
      icon = 'octicon-file';
    } else if (Matcher.isImage(filePath)) {
      contentPromise = renderer.renderImageFile(route);
      icon = 'octicon-file-media';
    } else if (Matcher.isSourceCode(filePath)) {
      contentPromise = renderer.renderSourceCode(filePath, path.extname(filePath).replace('.', ''));
      icon = 'octicon-file-code';
    }

    if (!title) {
      title = search ? renderer.searchResults : path.basename(filePath);
    }

    if (contentPromise) {
      return contentPromise.then((content) => {
        res.render(edit ? 'edit' : 'file', {
          title: title,
          route: route,
          icon: icon,
          search: search,
          content: content,
          styles: STYLESHEETS,
          scripts: SCRIPTS,
          pkg: pkg
        });
      });
    } else {
      next();
    }
  }

  function tryProcessFile() {
    contentPromise = null;
    filePath = path.join(rootPath, route);

    return fs.statAsync(filePath)
      .then((stat) => {
        search = query.search && query.search.length > 0 ? query.search.trim() : null;

        if (stat.isDirectory() && !search && !error) {
          if (!create) {
            // Try to find a root file
            route = path.join(route, ROOT_FILES[++rootIndex]);
            return tryProcessFile();
          } else {
            route = '/';
            title = 'Error';
            error = `Cannot create file \`${filePath}\``;
          }
        }

        return renderPage();
      })
      .catch(() => {
        if (create) {
          let fixedRoute = Helpers.ensureMarkdownExtension(route);
          if (fixedRoute !== route) {
            return res.redirect(fixedRoute + '?create=1');
          }

          return mkdirpAsync(path.dirname(filePath))
            .then(() => fs.writeFileAsync(filePath, ''))
            .then(() => indexer.updateIndexForFile(filePath))
            .then(tryProcessFile)
            .catch((e) => {
              console.error(e);
              title = 'Error';
              error = `Cannot create file \`${filePath}\``;
              route = '/';
              return renderPage();
            });
        } else if (rootIndex !== -1 && rootIndex < ROOT_FILES.length - 1) {
          route = path.join(path.dirname(route), ROOT_FILES[++rootIndex]);
          return tryProcessFile();
        } else {
          if (path.dirname(route) === path.sep && rootIndex === ROOT_FILES.length - 1) {
            error = '## No home page (╥﹏╥)\nDo you want to create an [index.md](/index.md?create=1) or ' +
              '[readme.md](/readme.md?create=1) file perhaps?'
          } else {
            error = '## File not found ¯\\\\\\_(◕\\_\\_◕)_/¯\n> *There\'s a glitch in the matrix...*';
          }
          title = '404 Error';
          route = '/';

          return renderPage();
        }
      });
  }

  tryProcessFile();
});

app.post('*', (req, res, next) => {
  let route = Helpers.extractRoute(req.path);
  let filePath = path.join(rootPath, route);

  fs.statAsync(filePath)
    .then((stat) => {
      if (stat.isFile() && req.body.content) {
        return fs.writeFileAsync(filePath, req.body.content);
      }
    })
    .then(() => {
      indexer.updateIndexForFile(filePath);
      return renderer.renderFile(filePath);
    })
    .then((content) => {
      res.render('file', {
        title: path.basename(filePath),
        route: route,
        icon: 'octicon-file',
        content: content,
        styles: STYLESHEETS,
        scripts: SCRIPTS,
        pkg: pkg
      });
    })
    .catch(() => {
      next();
    })
});

indexer.indexFiles().then(() => {
  app.listen(args.port, args.host, () => {
    let serverUrl = `http://${args.host}:${args.port}`;
    console.log(`${pkg.name} ${pkg.version} serving at ${serverUrl} (press CTRL+C to exit)`);

    if (args.open) {
      require('open')(serverUrl);
    }
  });
});