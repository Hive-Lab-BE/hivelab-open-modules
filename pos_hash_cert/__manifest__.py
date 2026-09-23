{
    'name': 'Certification Hash PdV',
    'version': '19.0.0.0.0',
    'author': 'Mayam',
    'license': 'LGPL-3',
    'category': 'Sales/Point of Sale',
    'summary': 'Certification checksum des modules PdV (conformité LNE)',
    'description': """
Certification Hash PdV
======================

Ce module fournit la certification par checksum côté serveur pour les modules PdV.
Conforme aux exigences LNE (Laboratoire National de métrologie et d'Essais).

Fonctionnalités :
- Point d'accès API /pos/module_hash retournant les hachages SHA256 des modules
- Point d'accès HTML /pos/module_hash/html accessible dans le navigateur
- Icône balance dans l'en-tête PdV (vert/rouge selon le statut de certification)
- Popup style Enterprise avec informations système et statut de certification
- Champs de configuration : numéro de certificat LNE, éditeur

Fait partie du système POS métrologique MAYAM pour Vracoop.
    """,
    'depends': [
        'pos_container',
    ],
    'data': [
        'security/ir.model.access.csv',
        'views/pos_config_views.xml',
        'views/pos_config_form_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_hash_cert/static/src/**/*',
            ('remove', 'pos_hash_cert/static/src/customer_display_overrides/**/*'),
        ],
        'point_of_sale.customer_display_assets': [
            'pos_hash_cert/static/src/customer_display_overrides/**/*',
        ],
    },
    'installable': True,
    'application': False,
}
