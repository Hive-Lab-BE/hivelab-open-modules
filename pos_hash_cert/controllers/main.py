import html as html_mod

from odoo import fields, http
from odoo.http import request

from odoo.addons.pos_hash_cert.controllers.checksum import calculate_checksum
from odoo.addons.pos_hash_cert.controllers.expected_checksum import EXPECTED_CHECKSUM


class PosHashCertificationController(http.Controller):
    """Controller for POS module hash certification (LNE compliance)."""

    @http.route('/pos/module_hash', type='jsonrpc', auth='user', methods=['POST'])
    def get_module_hashes(self):
        """Returns global hash certification info via JSON-RPC."""
        global_hash, files_data = calculate_checksum()

        return {
            'status': 'success',
            'global_hash': global_hash,
            'expected_hash': EXPECTED_CHECKSUM,
            'is_certified': global_hash == EXPECTED_CHECKSUM,
            'files': [
                {
                    'name': f['name'],
                    'hash': f['hash'],
                    'size_in_bytes': f['size_in_bytes'],
                }
                for f in files_data
            ],
            'server_time': str(fields.Datetime.now()),
        }

    @http.route('/pos/module_hash/html', auth='user')
    def module_hash_html(self):
        """Returns a minimal HTML page with hash certification details."""
        global_hash, files_data = calculate_checksum()
        is_certified = global_hash == EXPECTED_CHECKSUM

        status_label = "Certifié" if is_certified else "NON Certifié"

        file_rows = "\n".join(
            f'<tr>'
            f'<td><code>{html_mod.escape(f["name"])}</code></td>'
            f'<td><code>{html_mod.escape(f["hash"])}</code></td>'
            f'<td style="text-align:right">{f["size_in_bytes"]}</td>'
            f'</tr>'
            for f in files_data
        )

        file_details = "\n".join(
            f'<details>'
            f'<summary><code>{html_mod.escape(f["name"])}</code></summary>'
            f'<pre>{html_mod.escape(f["contents"])}</pre>'
            f'</details>'
            for f in files_data
        )

        page = f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Certification LNE — Mayam</title>
<style>
  body {{ font-family: monospace; max-width: 900px; margin: 0 auto; padding: 24px; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ text-align: left; padding: 6px 8px; border-bottom: 1px solid #ccc; }}
  pre {{ overflow-x: auto; background: #f5f5f5; padding: 12px; }}
</style>
</head>
<body>
<h1>Certification Métrologique LNE</h1>
<p>Mayam — Point de Vente Certifié</p>
<p><strong>Statut :</strong> {status_label}</p>

<h2>Signatures</h2>
<p><strong>Global Hash (SHA-256) :</strong><br><code>{html_mod.escape(global_hash)}</code></p>
<p><strong>Hash Attendu :</strong><br><code>{html_mod.escape(EXPECTED_CHECKSUM)}</code></p>

<h2>Fichiers Certifiés ({len(files_data)})</h2>
<table>
  <thead>
    <tr><th>Fichier</th><th>Hash SHA-256</th><th style="text-align:right">Taille (octets)</th></tr>
  </thead>
  <tbody>
    {file_rows}
  </tbody>
</table>

<h2>Contenu des Fichiers</h2>
{file_details}
</body>
</html>"""

        return request.make_response(page, [
            ('Content-Type', 'text/html; charset=utf-8'),
        ])
