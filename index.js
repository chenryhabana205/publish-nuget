const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

class Action {
  constructor() {
    this.projectFile = process.env.INPUT_PROJECT_FILE_PATH;
    this.packageName = process.env.INPUT_PACKAGE_NAME;
    this.versionRegex = new RegExp(process.env.INPUT_VERSION_REGEX, "m");
    this.nugetKey = process.env.INPUT_NUGET_KEY;
    this.nugetSource = process.env.INPUT_NUGET_SOURCE; // Host de Nexus
    this.repository = process.env.INPUT_NEXUS_REPOSITORY || "nuget-hosted"; // Repositorio de Nexus
    this.version = process.env.INPUT_VERSION_STATIC;
    this.includeSymbols = JSON.parse(process.env.INPUT_INCLUDE_SYMBOLS || "false");

    // Credenciales para Nexus
    this.nexusUsername = process.env.INPUT_NEXUS_USERNAME;
    this.nexusPassword = process.env.INPUT_NEXUS_PASSWORD;

    this.newVersionGenerated = false; // Estado de la acción
  }

  _executeCommand(cmd, options = {}) {
    console.log(`Executing: ${cmd}`);
    const [command, ...args] = cmd.split(" ");
    const result = spawnSync(command, args, {
      ...options,
      stdio: "inherit", // Usa buffers del sistema directamente
    });

    // result.error is only set when the process could not be SPAWNED at all.
    // A command that runs and then fails - a failing dotnet build, or a push
    // Nexus rejects - leaves error undefined and reports itself in status.
    if (result.error) {
      console.error(`❌ Command could not be started: ${result.error.message}`);
      process.exit(1);
    }

    if (result.status !== 0) {
      const how = result.signal ? `killed by ${result.signal}` : `exit code ${result.status}`;
      console.error(`❌ Command failed (${how}): ${cmd}`);
      process.exit(result.status || 1);
    }

    return result.status;
  }

  /**
   * NuGet does not store a version verbatim - it normalizes it, and the feed only ever knows the
   * normalized form. Two rules matter here:
   *   - leading zeroes are stripped from each numeric part  (1.0.01.0 -> 1.0.1)
   *   - a fourth part equal to zero is dropped              (1.0.4.0  -> 1.0.4)
   * A csproj saying <Version>1.0.4.0</Version> therefore publishes as 1.0.4, and asking the feed
   * about "1.0.4.0" finds nothing at all - which used to look like "this version is new".
   * Any prerelease or build-metadata suffix is preserved untouched.
   */
  _normalizeVersion(version) {
    const match = /^(\d+(?:\.\d+)*)(.*)$/.exec(String(version).trim());
    if (!match) return version;

    const parts = match[1].split(".").map((p) => String(parseInt(p, 10)));
    if (parts.some((p) => p === "NaN")) return version;
    if (parts.length === 4 && parts[3] === "0") parts.pop();

    return parts.join(".") + match[2];
  }

  _checkVersionExists(packageName, version) {
    return new Promise((resolve, reject) => {
      const normalized = this._normalizeVersion(version);
      if (normalized !== version) {
        console.log(`🔧 NuGet normalizes ${version} to ${normalized}; asking the feed about that.`);
      }

      const url = `${this.nugetSource}/service/rest/v1/search?repository=${this.repository}&name=${packageName}&version=${normalized}`;
      console.log(`Checking version existence with Search API: ${url}`);

      const requestOptions = this._buildRequestOptions(url);

      const client = url.startsWith("https") ? https : http;
      client.get(requestOptions, (res) => {
        let body = "";

        if (res.statusCode === 404) {
          console.log(`ℹ️ Package ${packageName} version ${version} not found.`);
          return resolve(false); // Versión no encontrada
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Unexpected HTTP status code: ${res.statusCode}`));
        }

        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);

            // Accept either form. The feed should only ever hold the normalized version, but
            // matching both costs nothing and means a feed that kept the raw one still counts.
            const versionExists = (data.items || []).some(
              (item) =>
                item.name === packageName &&
                (item.version === version ||
                  this._normalizeVersion(item.version) === normalized)
            );

            if (versionExists) {
              console.log(`ℹ️ Version ${version} of package ${packageName} exists.`);
              resolve(true);
            } else {
              console.log(`ℹ️ Version ${version} of package ${packageName} not found.`);
              resolve(false);
            }
          } catch (err) {
            console.error("❌ Error parsing JSON response:", err.message);
            reject(err);
          }
        });
      }).on("error", (e) => {
        console.error("❌ HTTP request failed:", e.message);
        reject(e);
      });
    });
  }

  _buildRequestOptions(url) {
    const options = new URL(url);

    if (this.nexusUsername && this.nexusPassword) {
      const auth = Buffer.from(`${this.nexusUsername}:${this.nexusPassword}`).toString("base64");
      options.headers = {
        Authorization: `Basic ${auth}`,
      };
    }

    return options;
  }

  async run() {
    console.log(`📦 Package Name: ${this.packageName}`);
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
      const versionExists = await this._checkVersionExists(this.packageName, this.version);
      if (versionExists) {
        console.log(`ℹ️ Version ${this.version} already exists. No new version will be uploaded.`);
        return; // Detiene la ejecución si la versión ya existe
      }

      console.log(`✨ New version ${this.version} detected. Preparing to upload...`);
      await this._pushPackage(this.version, this.packageName);
      console.log(`✅ New version ${this.version} was uploaded successfully.`);
    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  }

  async _pushPackage(version, name) {
    console.log(`Building and packing the project...`);
    this._executeCommand(`dotnet build -c Release ${this.projectFile}`);
    const packCmd = `dotnet pack ${
      this.includeSymbols ? "--include-symbols -p:SymbolPackageFormat=snupkg" : ""
    } --no-build -c Release ${this.projectFile} -o .`;
    this._executeCommand(packCmd);

    console.log("Uploading packages...");
    const pushCmd = `dotnet nuget push *.nupkg --source ${this.nugetSource}/repository/${this.repository}/ --api-key ${this.nugetKey} -n`;
    this._executeCommand(pushCmd);

    this.newVersionGenerated = true;
  }
}

new Action().run().catch((err) => {
  console.error(`❌ Unexpected error: ${err.message}`);
  process.exit(1);
});
