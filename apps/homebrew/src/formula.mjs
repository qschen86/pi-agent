/** Generate only from a fixed release URL and the actual archive bytes. */
export function renderFormula({ repository, version, sha256 }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository ?? '') ||
    !/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw Error('发行仓库、版本或 SHA256 无效');
  return `class PiAgent < Formula
  desc "Self-hosted local AI workspace"
  homepage "https://github.com/${repository}"
  url "https://github.com/${repository}/releases/download/v${version}/pi-agent-${version}-macos-arm64.tar.gz"
  version "${version}"
  sha256 "${sha256}"
  license "MIT"

  depends_on arch: :arm64
  depends_on macos: :sequoia
  depends_on "node@24"

  def install
    libexec.install Dir["*"]
    inreplace libexec/"bin/node", "@HOMEBREW_NODE@", Formula["node@24"].opt_bin/"node"
    (bin/"pi-agent").write <<~SH
      #!/bin/sh
      exec "#{Formula["node@24"].opt_bin}/node" "#{opt_libexec}/main.mjs" "$@"
    SH
    chmod 0755, bin/"pi-agent"
  end

  service do
    run [opt_bin/"pi-agent", "serve"]
    keep_alive true
    process_type :background
    working_dir Dir.home
    log_path var/"log/pi-agent.log"
    error_log_path var/"log/pi-agent.log"
  end

  def caveats
    <<~EOS
      Start: brew services start pi-agent
      Open:  pi-agent open
      Data:  ~/Library/Application Support/pi-agent/instance/
      Uninstall preserves your private instance. Do not run the service with sudo.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/pi-agent --version").strip
    assert_match '"state":"stopped"', shell_output("#{bin}/pi-agent status --json --data-parent '#{testpath}/empty'")
  end
end
`;
}
