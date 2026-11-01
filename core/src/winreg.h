#ifndef SHROUDLY_WINREG_H
#define SHROUDLY_WINREG_H

/* shroudly-core --reg query|add|delete KEY [/v NAME | /ve] [/t TYPE] [/d DATA] [/s] [/f]
 *
 * Windows' registry with reg.exe's own arguments, output and exit codes, for
 * a computer where Windows will not start reg.exe (issue #64). See winreg.c. */
int winreg_main(int argc, char **argv);

#endif
