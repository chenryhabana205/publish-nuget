const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

class Action {
  constructor() {
    this.projectFile = process.env.INPUT_PROJECT_FILE_PATH;
    this.packageName = process.env.INPUT_PACKAGE_NAME;
    this.versionRegex = new RegExp(process.env.INPUT_VERSION_REGEX, "m");
    this.nugetKey = process.env.INPUT_NUGET_KEY;
    this.nugetSource = process.env.INPUT_NUGET_SOURCE;
    this.version = process.env.INPUT_VERSION_STATIC;
    this.includeSymbols = JSON.parse(process.env.INPUT_INCLUDE_SYMBOLS || "false");
    this.newVersionGenerated = false; // Flag para el estado de la acción
  }

  _executeCommand(cmd, options = {}) {
    console.log(`Executing: ${cmd}`);
    const [command, ...args] = cmd.split(" ");
    const result = spawnSync(command, args, {
      ...options,
      stdio: "inherit", // Redirige la salida directamente al proceso principal
    });
  
    if (result.error) {
      console.error(`Command failed: ${result.error.message}`);
      process.exit(1);
    }
  
    return result.status;
  }

  _fetchExistingVersions(packageName) {
    return new Promise((resolve, reject) => {
      const url = `${this.nugetSource}/v3-flatcontainer/${packageName}/index.json`;
      https.get(url, (res) => {
        if (res.statusCode === 404) return resolve([]);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(data.versions || []);
          } catch (err) {
            reject(err);
          }
        });
      }).on("error", reject);
    });
  }

  async _pushPackage(version, name) {
    console.log(`✨ Generating new version: ${version}`);

    if (!this.nugetKey) {
      console.warn("⚠️  NUGET_KEY not provided. Skipping upload.");
      return;
    }

    console.log("Building and packing the project...");
    this._executeCommand(`dotnet build -c Release  --verbosity quiet ${this.projectFile}`);
    const packCmd = `dotnet pack ${
      this.includeSymbols ? "--include-symbols -p:SymbolPackageFormat=snupkg" : ""
    } --no-build --verbosity quiet -c Release ${this.projectFile} -o .`;
    this._executeCommand(packCmd);

    console.log("Uploading packages...");
    const pushCmd = `dotnet nuget push *.nupkg --source ${this.nugetSource} --api-key ${this.nugetKey} --skip-duplicate`;
    this._executeCommand(pushCmd);

    this.newVersionGenerated = true; // Marca como generado
    console.log(`✅ Version ${version} has been uploaded successfully.`);
  }

  async run() {
    if (!this.projectFile || !fs.existsSync(this.projectFile)) {
      console.error("❌ Project file not found.");
      process.exit(1);
    }

    console.log(`📂 Project File: ${this.projectFile}`);

    if (!this.version) {
      console.log(`🔍 Extracting version using regex: ${this.versionRegex}`);
      const content = fs.readFileSync(this.projectFile, "utf-8");
      const match = this.versionRegex.exec(content);
      if (!match) {
        console.error("❌ Version not found in project file.");
        process.exit(1);
      }
      this.version = match[1];
    }

    console.log(`📦 Package Version: ${this.version}`);

    try {
      const existingVersions = await this._fetchExistingVersions(this.packageName);
      if (existingVersions.includes(this.version)) {
        console.log(`ℹ️  Version ${this.version} already exists. No new version was generated.`);
        return;
      }

      await this._pushPackage(this.version, this.packageName);
    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }

    if (this.newVersionGenerated) {
      console.log(`✅ New version ${this.version} was generated and published.`);
    } else {
      console.log(`ℹ️  No new version was generated.`);
    }
  }
}

new Action().run().catch((err) => {
  console.error(`❌ Unexpected error: ${err.message}`);
  process.exit(1);
});
