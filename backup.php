<?php
define('DB_HOST', '__DB_HOST__');
define('DB_PORT', __DB_PORT__);
define('DB_USER', '__DB_USER__');
define('DB_PASS', '__DB_PASS__');
define('DB_NAME', '__DB_NAME__');

set_time_limit(0);
ini_set('memory_limit', '512M');

header('Content-Type: text/plain; charset=utf-8');

$file = __DIR__ . '/backup.sql';

function finish($msg)
{
    echo $msg;
    if (is_file(__FILE__)) {
        @unlink(__FILE__);
    }
    exit;
}

if (DB_HOST === '' || DB_USER === '' || DB_NAME === '' || strpos(DB_HOST, '__') === 0) {
    finish('error: db config missing (template not filled)');
}

$fh = null;

try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION)
    );

    $fh = fopen($file, 'w');
    if ($fh === false) {
        throw new Exception('cannot create backup.sql (dir not writable)');
    }

    fwrite($fh, "-- Database Backup\n-- Generated: " . date('Y-m-d H:i:s') . "\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n");

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
                $cols = '`' . implode('`,`', array_keys($row)) . '`';
            }
            $vals = array_map(function ($v) use ($pdo) {
                return $v === null ? 'NULL' : $pdo->quote($v);
            }, array_values($row));
            $line = "INSERT INTO `{$t}` ({$cols}) VALUES (" . implode(',', $vals) . ");\n";
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
    $fh = null;

    clearstatcache();
    if (!file_exists($file) || filesize($file) === 0) {
        throw new Exception('backup.sql is empty');
    }
    finish('backup success ' . filesize($file));
} catch (Exception $e) {
    if ($fh !== null && is_resource($fh)) {
        fclose($fh);
    }
    finish('error: ' . $e->getMessage());
}
