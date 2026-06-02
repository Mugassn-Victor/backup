<?php
define('DB_HOST', '');
define('DB_PORT', 3306);
define('DB_USER', '');
define('DB_PASS', '');
define('DB_NAME', '');
define('DB_CHARSET', 'utf8mb4');

set_time_limit(0);
ini_set('memory_limit','512M');

$file = __DIR__.'/backup.sql';

header('Content-Type: text/plain; charset=utf-8');

if (isset($_GET['d'])) {
    if (!file_exists($file)) {
        exit('no file');
    }
    unlink($file);
    exit('delete success');
}

$exists = file_exists($file);

try {
    $pdo = new PDO('mysql:host='.DB_HOST.';port='.DB_PORT.';dbname='.DB_NAME.';charset='.DB_CHARSET, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $fh = fopen($file, 'w');
    fwrite($fh, "-- Database Backup\n-- Generated: ".date('Y-m-d H:i:s')."\nSET NAMES ".DB_CHARSET.";\nSET FOREIGN_KEY_CHECKS = 0;\n\n");

    foreach ($pdo->query('SHOW TABLES', PDO::FETCH_NUM) as $r) {
        $t = $r[0];
        $ct = $pdo->query("SHOW CREATE TABLE `{$t}`")->fetch(PDO::FETCH_NUM);
        fwrite($fh, "DROP TABLE IF EXISTS `{$t}`;\n{$ct[1]};\n\n");

        $rows = $pdo->query("SELECT * FROM `{$t}`", PDO::FETCH_ASSOC);
        $cols = null;
        $buf = '';
        $bufsize = 0;
        foreach ($rows as $row) {
            if ($cols === null) {
                $cols = '`'.implode('`,`', array_keys($row)).'`';
            }
            $vals = array_map(function($v) use ($pdo) { return $v === null ? 'NULL' : $pdo->quote($v); }, array_values($row));
            $line = "INSERT INTO `{$t}` ({$cols}) VALUES (".implode(',', $vals).");\n";
            $buf .= $line;
            $bufsize += strlen($line);
            if ($bufsize >= 1048576) {
                fwrite($fh, $buf);
                $buf = '';
                $bufsize = 0;
            }
        }
        if ($buf !== '') {
            fwrite($fh, $buf);
        }
        fwrite($fh, "\n");
    }

    fwrite($fh, "SET FOREIGN_KEY_CHECKS = 1;\n");
    fclose($fh);
    echo $exists ? 'overwrite backup success' : 'backup success';
} catch (Exception $e) {}
