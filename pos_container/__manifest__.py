{
    'name': 'Gestion Contenants PdV',
    'version': '19.0.0.0.0',
    'author': 'Mayam',
    'license': 'LGPL-3',
    'category': 'Sales/Point of Sale',
    'summary': 'Gestion des contenants réutilisables pour le PdV',
    'description': """
Gestion Contenants PdV
======================

Ce module fournit la gestion des contenants réutilisables pour la vente en vrac.

Fonctionnalités :
- Enregistrement des contenants avec code-barres EAN13 (préfixe 049)
- Suivi du poids de tare
- Gestion des consignes
- Scan de contenants dans le PdV

Fait partie du système POS métrologique MAYAM pour Vracoop.
    """,
    'depends': [
        'point_of_sale',
        'barcodes',
        'uom',
    ],
    'post_init_hook': '_init_barcode_sequence',
    'data': [
        'security/ir.model.access.csv',
        'security/pos_container_security.xml',
        'data/barcode_rule.xml',
        'data/config_data.xml',
        'views/pos_container_views.xml',
        'views/pos_container_menuitem.xml',
        'views/pos_order_views.xml',
        'views/pos_config_form_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_container/static/src/**/*',
        ],
        'web.assets_unit_tests': [
            'pos_container/static/tests/**/*',
        ],
    },
    'installable': True,
    'application': False,
}
