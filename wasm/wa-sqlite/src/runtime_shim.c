#include <sqlite3.h>

__attribute__((used, visibility("default")))
int analyst_wa_init(void) {
    return sqlite3_initialize();
}
