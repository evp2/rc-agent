import qrcodeTerminal from "qrcode-terminal";

/**
 * Which link the pairing QR encodes. Both grant Control; the Control link is
 * the default because it is far shorter than the relay URL with its embedded
 * secret, so the code is less dense and scans more reliably. `relay` asks for
 * the relay URL instead, which is also the only choice for a session whose
 * relay predates Control links.
 */
export function pairingQrUrl(
  urls: { phoneUrl: string; controlUrl?: string },
  relay: boolean,
): string {
  return relay || !urls.controlUrl ? urls.phoneUrl : urls.controlUrl;
}

/** Renders a scannable QR code for the pairing URL to stdout. */
export function printPairingQrCode(url: string): void {
  qrcodeTerminal.generate(url, { small: true });
}
