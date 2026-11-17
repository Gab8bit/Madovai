<?php
// Copy to config.php (same folder) to override defaults. Everything here is optional.
// Every key can also be set as an environment variable MADOVAI_<KEY> (e.g. MADOVAI_DATA_DIR).
return [
    // Writable folder for the SQLite databases and the file cache. Best kept OUTSIDE the web root.
    // 'data_dir' => '/var/www/madovai-data',

    // "Subject" sent to push services with every notification (must be a mailto: or https: URL you control).
    'vapid_subject' => 'mailto:admin@example.com',
];
