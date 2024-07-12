#!/usr/bin/env perl
# File tabulate_cell_types.pl by Marc Perry
# 
# 
# 
# Last Updated: 2024-07-11, Status: in development

use strict;
use warnings;
use JSON;

# N.B., this is a global hash data structure
# that gets built up or filled in as the various dataset.json
# files get processed by the script
my %cell_types = ();

my $first_json_path = "/usr/local/apache/htdocs-cells";
my $data = get_json( $first_json_path );

# the first time I call this, I want to get a list of dataset names
# NOTE: We _know_ that this top level file HAS to have datasets so we
# don't need to test that
my $array_ref = get_dataset_names( $data );
my @list_of_datasets = @{$array_ref};

iterate_over_list_of_names( \@list_of_datasets, );

# Send in an array
sub iterate_over_list_of_names {
    # first element passed in is an array ref
    my @list_of_datasets = @{ shift @_ };
    my $current_path = "/usr/local/apache/htdocs-cells";
    foreach my $ds_name ( @list_of_datasets ) {
        my $path_to_json = $current_path . '/' . $ds_name;
        # Now we are going to call, get_json() which gives us back a hashref
        my $decoded = get_json( $path_to_json );

        if ( exists $decoded->{datasets} ) {
            my $dataset_names = get_dataset_names( $decoded );
            my @new_list = @{$dataset_names};
            # recursive function call to this same subroutine
            iterate_over_list_of_names ( \@new_list, );
        }
        elsif ( exists $decoded->{clusterField} ) {
            extract_cell_types( $decoded, $ds_name, 'clusterField', );
        }
        elsif ( exists $decoded->{labelField} ) {
            extract_cell_types( $decoded, $ds_name, 'labelField', );        
        }
        elsif ( exists $decoded->{defColorField} ) {
            extract_cell_types( $decoded, $ds_name, 'defColorField', );        
        }
        else {
            print "Could not find a clusterField OR a labelField OR a defColorField value in cellbrowser.conf for dataset $ds_name\n";
	}
    } # close main foreach loop
} # close sub

open my ($FH), '>', 'this_is_the_new_cell-type_table.tsv' or die "Could not open file for writing: $!";

foreach my $cell_type ( sort keys %cell_types ) {
    print $FH "$cell_type\t", join(",", @{$cell_types{$cell_type}} ), "\n";
} # close foreach loop

close $FH;

exit;

# We only call this one when we know that we have arrived at a dataset.json file
# that contains NO key named datasets.
sub extract_cell_types {
    my %dataset = %{ shift @_ };
    my $dataset_name = shift;
    my $meta_field = shift;
    print "\$dataset_name contains: $dataset_name\n";
    my $cluster = $dataset{$meta_field};
    if ( $cluster ) {
        print "\t\$cluster contains: $cluster\n";
        foreach my $field ( @{$dataset{metaFields}} ) {
            if ( $field->{name} eq $cluster ) {
                if (exists $field->{valCounts} ) {
                    my @values = @{ $field->{valCounts} };
                    foreach my $value ( @values ) {
                        my $cell_type = $value->[0];
                        print "\t\t\$cell_type contains: $cell_type\n";
                        push( @{$cell_types{$cell_type}}, $dataset_name, ); 
                    } # close inner foreach loop
                }
                else {
                    print "\t\t\$cluster named $cluster does not contain any valCounts!! WTF?\n";
		}
            }
            else { 
                next;
            }
        } # close outer foreach loop
    }
    else {
        print "\t\$cluster was uninitialized for \$dataset_name: $dataset_name\n";
    }
} # close sub


# INPUT, a hashref
# OUTPUT, an arrayref
sub get_dataset_names {
    my $data = shift;
    my @dataset_names = ();
    # Iterating over the array of Perl hashes
    foreach my $dataset ( @{$data->{datasets}} ) {
        # extracting the UCSC Cell Browser dataset name for the current dataset
        my $name = $dataset->{name};
        push( @dataset_names, $name, );
    } # close foreach;
    return \@dataset_names;
} # close sub


# INPUT: a directory path
# OUTPUT: a hashref
sub get_json {
    my $path_to_json = shift;
    my $json_file = $path_to_json . '/dataset.json';
    unless ( -e -f -r $json_file ) {
        die "The JSON document you are trying to access, $json_file,  either does not exist, is not a file, or is not readable\n";
    }

    open my ($FH), '<', $json_file or die "Could not open $json_file";

    my $json_lines = q{};
    while ( <$FH> ) {
        $json_lines .= $_;
    }
    close $FH;
    my $data = decode_json( $json_lines );
    return $data;
} # close sub

__END__
