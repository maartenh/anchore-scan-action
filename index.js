const cache = require("@actions/tool-cache");
const core = require("@actions/core");
const { exec } = require("@actions/exec");
const fs = require("fs");
const stream = require("stream");
const { GRYPE_VERSION } = require("./GrypeVersion");

const grypeBinary = "grype";
const grypeVersion = core.getInput("grype-version") || GRYPE_VERSION;

async function downloadGrype(version) {
  let url = `https://raw.githubusercontent.com/anchore/grype/main/install.sh`;

  core.debug(`Installing ${version}`);

  // TODO: when grype starts supporting unreleased versions, support it here
  // Download the installer, and run
  const installPath = await cache.downloadTool(url);
  // Make sure the tool's executable bit is set
  await exec(`chmod +x ${installPath}`);

  let cmd = `${installPath} -b ${installPath}_grype ${version}`;
  await exec(cmd);
  let grypePath = `${installPath}_grype/grype`;

  // Cache the downloaded file
  return cache.cacheFile(grypePath, `grype`, `grype`, version);
}

async function installGrype(version) {
  let grypePath = cache.find(grypeBinary, version);
  if (!grypePath) {
    // Not found, install it
    grypePath = await downloadGrype(version);
  }

  // Add tool to path for this and future actions to use
  core.addPath(grypePath);
  return `${grypePath}/${grypeBinary}`;
}

// Determines if multiple arguments are defined
function multipleDefined(...args) {
  let defined = false;
  for (const a of args) {
    if (defined && a) {
      return true;
    }
    if (a) {
      defined = true;
    }
  }
  return false;
}

function sourceInput() {
  var image = core.getInput("image");
  var path = core.getInput("path");
  var sbom = core.getInput("sbom");

  if (multipleDefined(image, path, sbom)) {
    throw new Error(
      "The following options are mutually exclusive: image, path, sbom"
    );
  }

  if (image) {
    return image;
  }

  if (sbom) {
    return "sbom:" + sbom;
  }

  if (!path) {
    // Default to the CWD
    path = ".";
  }

  return "dir:" + path;
}

async function run() {
  try {
    core.debug(new Date().toTimeString());
    // Grype accepts several input options, initially this action is supporting both `image` and `path`, so
    // a check must happen to ensure one is selected at least, and then return it
    const source = sourceInput();
    const failBuild = core.getInput("fail-build") || "true";
    const acsReportEnable = core.getInput("acs-report-enable") || "true";
    const outputFormat = core.getInput("output-format") || "sarif";
    const severityCutoff = core.getInput("severity-cutoff") || "medium";
    const out = await runScan({
      source,
      failBuild,
      acsReportEnable,
      severityCutoff,
      outputFormat,
    });
    Object.keys(out).map((key) => {
      core.setOutput(key, out[key]);
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function runScan({
  source,
  failBuild,
  acsReportEnable,
  severityCutoff,
  outputFormat,
}) {
  core.debug("Source: " + source);
  core.debug("Fail Build: " + failBuild);
  core.debug("Severity Cutoff: " + severityCutoff);
  core.debug("ACS Enable: " + acsReportEnable);
  core.debug("Output Format: " + outputFormat);

  const out = {};

  const env = {
    GRYPE_CHECK_FOR_APP_UPDATE: "false",
  };

  const registryUser = core.getInput("registry-username");
  const registryPass = core.getInput("registry-password");

  if (registryUser || registryPass) {
    env.GRYPE_REGISTRY_AUTH_USERNAME = registryUser;
    env.GRYPE_REGISTRY_AUTH_PASSWORD = registryPass;
    if (!registryUser || !registryPass) {
      core.warning(
        "WARNING: registry-username and registry-password must be specified together"
      );
    }
  }

  const SEVERITY_LIST = ["negligible", "low", "medium", "high", "critical"];
  const FORMAT_LIST = [
    "sarif",
    "json",
    "table",
    "cyclonedx",
    "embedded-cyclonedx-vex-json",
    "embedded-cyclonedx-vex-xml",
  ];

  failBuild = failBuild.toLowerCase() === "true";

  acsReportEnable = acsReportEnable.toLowerCase() === "true";

  if (outputFormat !== "sarif" && acsReportEnable) {
    throw new Error(
      `Invalid output-format selected. If acs-report-enabled is true (which is the default if it is omitted), the output-format parameter must be sarif or must be omitted`
    );
  }

  if (acsReportEnable) {
    outputFormat = "sarif";
    // the acsReportEnable parameter is unused after this point, allowing for easier future removal of the parameter.
  }

  if (
    !SEVERITY_LIST.some(
      (item) =>
        typeof severityCutoff.toLowerCase() === "string" &&
        item === severityCutoff.toLowerCase()
    )
  ) {
    throw new Error(
      `Invalid severity-cutoff value is set to ${severityCutoff} - please ensure you are choosing either negligible, low, medium, high, or critical`
    );
  }
  if (
    !FORMAT_LIST.some(
      (item) =>
        typeof outputFormat.toLowerCase() === "string" &&
        item === outputFormat.toLowerCase()
    )
  ) {
    throw new Error(
      `Invalid output-format value is set to ${outputFormat} - please ensure you are choosing either sarif, json, table, cyclonedx, embedded-cyclonedx-vex-json, or embedded-cyclonedx-vex-xml`
    );
  }

  core.debug(`Installing grype version ${grypeVersion}`);
  await installGrype(grypeVersion);

  core.debug("Creating options for GRYPE analyzer");

  // Run the grype analyzer
  let cmdOutput = "";
  let cmd = `${grypeBinary}`;
  let cmdArgs = [];

  if (core.isDebug()) {
    cmdArgs.push(`-vv`);
  }
  if (severityCutoff !== "") {
    cmdArgs.push("--fail-on");
    cmdArgs.push(severityCutoff.toLowerCase());
  }
  cmdArgs.push("-o", outputFormat);

  cmdArgs.push(source);

  // This /dev/null writable stream is required so the entire Grype output
  // is not written to the GitHub action log. the listener below
  // will actually capture the output
  const outStream = new stream.Writable({
    write(buffer, encoding, next) {
      next();
    },
  });

  const exitCode = await core.group(`${cmd} output...`, async () => {
    core.info(`Executing: ${cmd} ` + cmdArgs.join(" "));

    return exec(cmd, cmdArgs, {
      env,
      ignoreReturnCode: true,
      outStream,
      listeners: {
        stdout(buffer) {
          cmdOutput += buffer.toString();
        },
        stderr(buffer) {
          core.info(buffer.toString());
        },
        debug(message) {
          core.debug(message);
        },
      },
    });
  });

  if (core.isDebug()) {
    core.debug("Grype output:");
    core.debug(cmdOutput);
  }

  if (outputFormat === "sarif") {
    const SARIF_FILE = "./results.sarif";
    fs.writeFileSync(SARIF_FILE, cmdOutput);
    out.sarif = SARIF_FILE;
    out.report = SARIF_FILE; // Future updates can consolidate on using just the report output for any report file.
  } else {
    const REPORT_FILE = "./results.report";
    fs.writeFileSync(REPORT_FILE, cmdOutput);
    out.report = REPORT_FILE;
  }

  if (failBuild === true && exitCode > 0) {
    core.setFailed(
      `Failed minimum severity level. Found vulnerabilities with level ${severityCutoff} or higher`
    );
  }

  // If there is a non-zero exit status code there are a couple of potential reporting paths
  if (failBuild === false && exitCode > 0) {
    // There was a non-zero exit status but it wasn't because of failing severity, this must be
    // a grype problem
    if (!severityCutoff) {
      core.warning("grype had a non-zero exit status when running");
    } else {
      // There is a non-zero exit status code with severity cut off, although there is still a chance this is grype
      // that is broken, it will most probably be a failed severity. Using warning here will make it bubble up in the
      // Actions UI
      core.warning(
        `Failed minimum severity level. Found vulnerabilities with level ${severityCutoff} or higher`
      );
    }
  }

  return out;
}

module.exports = {
  run,
  runScan,
  installGrype,
};

if (require.main === module) {
  const entrypoint = core.getInput("run");
  switch (entrypoint) {
    case "download-grype": {
      installGrype(grypeVersion).then((path) => {
        core.info(`Downloaded Grype to: ${path}`);
        core.setOutput("cmd", path);
      });
      break;
    }
    default: {
      run().then();
    }
  }
}
