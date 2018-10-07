const pathJoin = require('path').join;
const fs = require('fs-extra');
const uuid = require('uuid/v1');
const sane = require('sane');
const homeDir = require('os').homedir();
const spawn = require('@expo/spawn-async');
const { syncAllPackages, syncPackage } = require('./utils');

const globeDir = process.cwd();
const globeHomeDir = pathJoin(homeDir, '.globe');
const globeStatePath = pathJoin(globeDir, '.globe.state.json');

const getAllGlobeDependencies = async (globeDir, packageName) => {
  const packageDir = pathJoin(globeDir, packageName);
  const packageJSONPath = pathJoin(packageDir, 'package.json');
  const pkgJSON = JSON.parse(await fs.readFile(packageJSONPath));
  const pkgDeps = (pkgJSON.globe && pkgJSON.globe.globeDependencies) || [];
  const childPkgDeps = await Promise.all(
    pkgDeps.map(async pkgDep => {
      return await getAllGlobeDependencies(globeDir, pkgDep);
    }),
  );
  const allPkgDeps = new Set(pkgDeps);
  allPkgDeps.add(packageName);
  childPkgDeps.forEach(cPkgDeps =>
    cPkgDeps.forEach(cPkgDep => allPkgDeps.add(cPkgDep)),
  );
  return allPkgDeps;
};

const getAllModuleDependencies = async (globeDir, packageName) => {
  const packageDir = pathJoin(globeDir, packageName);
  const packageJSONPath = pathJoin(packageDir, 'package.json');
  const pkgJSON = JSON.parse(await fs.readFile(packageJSONPath));
  const pkgDeps = (pkgJSON.globe && pkgJSON.globe.globeDependencies) || [];
  const moduleDeps = (pkgJSON.globe && pkgJSON.globe.moduleDependencies) || [];
  const childPkgDeps = await Promise.all(
    pkgDeps.map(async pkgDep => {
      return await getAllModuleDependencies(globeDir, pkgDep);
    }),
  );
  const allModuleDeps = new Set(moduleDeps);
  childPkgDeps.forEach(cPkgDeps =>
    cPkgDeps.forEach(cPkgDep => allModuleDeps.add(cPkgDep)),
  );
  return allModuleDeps;
};

const globeEnvs = {
  dom: require('./dom'),
  expo: require('./expo'),
  web: require('./web'),
};

const getAppPackage = async appName => {
  const appDir = pathJoin(globeDir, appName);
  const appPkgPath = pathJoin(appDir, 'package.json');
  let appPkg = null;
  try {
    appPkg = JSON.parse(await fs.readFile(appPkgPath));
  } catch (e) {
    throw new Error(`Failed to read package file at "${appPkgPath}"`);
  }
  return appPkg;
};

const getAppEnv = async (appName, appPkg) => {
  const envName = appPkg && appPkg.globe && appPkg.globe.env;
  let envModule = globeEnvs[envName];
  if (!envModule) {
    const envPath = pathJoin(globeDir, envName);
    if (!(await fs.exists(envPath))) {
      throw new Error(
        `Failed to load platform env "${envName}" as specified in package.json globe.env for "${appName}"`,
      );
    }
    envModule = require(pathJoin(envPath, 'GlobeEnv.js'));
    envModule.localGlobeEnv = envName;
  }
  envModule.name = envName;
  return envModule;
};

const readGlobeState = async () => {
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(globeStatePath));
    if (state.globeDir !== globeDir) {
      state = {};
      console.log('Globe has moved! Removing old globe state..');
      await fs.remove(globeStatePath);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  return state;
};

const writeGlobeState = async state => {
  const stateData = JSON.stringify(state);
  await fs.writeFile(globeStatePath, stateData);
};

const changeAppState = async (appName, transactor) => {
  const state = await readGlobeState();
  let lastAppState = state.apps && state.apps[appName];
  await writeGlobeState({
    ...state,
    globeDir,
    apps: {
      ...state.apps,
      [appName]: transactor(lastAppState || {}),
    },
  });
};
const initLocation = async (appName, appPkg, platform, appState) => {
  const newLocation = pathJoin(homeDir, '.globe', appName + '_' + uuid());
  await fs.mkdirp(newLocation);
  await platform.init({
    globeDir,
    appName,
    appPkg,
    location: newLocation,
  });
  return {
    location: newLocation,
    ...appState,
  };
};
const getAppLocation = async (appName, appPkg, platform, appState) => {
  if (platform.runInPlace) {
    return { ...appState, location: pathJoin(globeDir, platform.name) };
  }
  if (!appState || !appState.location) {
    return await initLocation(appName, appPkg, platform, appState);
  }
  if (!(await fs.exists(appState.location))) {
    return await initLocation(appName, appPkg, platform, appState);
  }
  return appState;
};

const sync = async (appEnv, location, appName, appPkg, globeDir) => {
  const packageSourceDir = appEnv.getPackageSourceDir(location);

  await fs.mkdirp(packageSourceDir);

  const existingDirs = await fs.readdir(packageSourceDir);

  const globeDepsSet = await getAllGlobeDependencies(globeDir, appName);
  const globeDeps = Array.from(globeDepsSet);
  await Promise.all(
    existingDirs
      .filter(testPkgName => !globeDepsSet.has(testPkgName))
      .map(async pkgToRemove => {
        const pkgToRemovePath = pathJoin(packageSourceDir, pkgToRemove);
        await fs.remove(pkgToRemovePath);
      }),
  );
  await Promise.all(
    globeDeps.map(async globeDep => {
      await syncPackage(globeDep, globeDir, packageSourceDir);
    }),
  );

  const distPkgTemplate = await appEnv.getTemplatePkg(location);

  const distPkg = {
    ...distPkgTemplate,
    dependencies: {
      ...distPkgTemplate.dependencies,
      ...appPkg.dependencies,
    },
  };
  const globePkg = JSON.parse(
    await fs.readFile(pathJoin(globeDir, 'package.json')),
  );
  Array.from(await getAllModuleDependencies(globeDir, appName)).forEach(
    moduleDep => {
      if (globePkg.dependencies[moduleDep] == null) {
        throw new Error(
          `Cannot find dependency "${moduleDep}" inside package.json for globe at ${globeDir}`,
        );
      }
      distPkg.dependencies[moduleDep] = globePkg.dependencies[moduleDep];
    },
  );

  await appEnv.applyPackage({
    location,
    appName,
    appPkg,
    distPkg,
  });

  return { globeDeps };
};

const runStart = async argv => {
  const appName = argv._[1];
  const appPkg = await getAppPackage(appName);
  const appEnv = await getAppEnv(appName, appPkg);

  const state = await readGlobeState();
  let appState = state.apps && state.apps[appName];
  appState = await getAppLocation(appName, appPkg, appEnv, appState);
  const goSync = async () => {
    console.log(
      `🌐 🏹 Syncronizing Workspace to App "${appName}" at ${
        appState.location
      }`,
    );
    return await sync(appEnv, appState.location, appName, appPkg, globeDir);
  };
  await writeGlobeState({
    ...state,
    globeDir,
    apps: {
      ...state.apps,
      [appName]: appState,
    },
  });
  let syncState = await goSync();

  const watcher = sane(globeDir, { watchman: true });

  let syncTimeout = null;
  const scheduleSync = (filepath, root, stat) => {
    if (
      appEnv.localGlobeEnv &&
      filepath.substr(0, appEnv.localGlobeEnv.length) === appEnv.localGlobeEnv
    ) {
      return;
    }
    let shouldSync = false;
    for (let globeDep of syncState.globeDeps) {
      if (filepath.substr(0, globeDep.length) === globeDep) {
        shouldSync = true;
      }
    }
    if (!shouldSync) {
      return;
    }
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      goSync()
        .then(s => {
          syncState = s;
        })
        .catch(e => {
          console.log('ERROR after file change sync');
          console.error(e);
          process.exit(1);
        });
    }, 25);
  };
  watcher.on('change', scheduleSync);
  watcher.on('add', scheduleSync);
  watcher.on('delete', scheduleSync);
  await new Promise(resolve => {
    watcher.on('ready', () => {
      console.log(`🌐 👓 Watching ${globeDir} for changes`);
      resolve();
    });
  });

  await appEnv.start({
    globeDir,
    appName,
    appPkg,
    location: appState.location,
  });

  watcher.close();
};

const runBuild = async argv => {
  const appName = argv._[1];
  const appPkg = await getAppPackage(appName);
  const appEnv = await getAppEnv(appName, appPkg);
  const state = await readGlobeState();
  let appState = state.apps && state.apps[appName];
  appState = await getAppLocation(appName, appPkg, appEnv, appState);
  const buildId = uuid();
  const buildLocation = pathJoin(
    homeDir,
    '.globe',
    appName + '_build_' + buildId,
  );

  await fs.mkdirp(buildLocation);
  await appEnv.init({
    globeDir,
    appName,
    appPkg,
    location: buildLocation,
  });

  await sync(appEnv, buildLocation, appName, appPkg, globeDir);

  await appEnv.build({
    globeDir,
    appName,
    appPkg,
    location: buildLocation,
  });

  return { buildLocation };
};

const runDeploy = async argv => {
  const appName = argv._[1];
  const appPkg = await getAppPackage(appName);
  const appEnv = await getAppEnv(appName, appPkg);
  const state = await readGlobeState();
  let appState = state.apps && state.apps[appName];
  appState = await getAppLocation(appName, appPkg, appEnv, appState);
  const buildId = uuid();
  const buildLocation = pathJoin(
    homeDir,
    '.globe',
    appName + '_build_' + buildId,
  );

  await fs.mkdirp(buildLocation);
  await appEnv.init({
    globeDir,
    appName,
    appPkg,
    location: buildLocation,
  });

  await sync(appEnv, buildLocation, appName, appPkg, globeDir);

  await appEnv.build({
    globeDir,
    appName,
    appPkg,
    location: buildLocation,
  });

  await appEnv.deploy({
    globeDir,
    appName,
    appPkg,
    location: buildLocation,
  });

  return { buildLocation };
};
const runClean = async () => {
  await fs.remove(globeHomeDir);
  await fs.remove(globeStatePath);
};
module.exports = {
  runStart,
  runBuild,
  runDeploy,
  runClean,
};
